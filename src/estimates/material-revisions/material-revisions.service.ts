import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import { NotificationsService } from '@/notifications/notifications.service';
import { PromotionsService } from '@/promotions/promotions.service';
import { createEstimateRevisionPieceFingerprint } from '@/installation/installation-flow-policy';
import { legacyMaterialRevisionPlan } from './material-revision-payments';
import { savedPromotions } from '@/promotions/promotion-pricing';
import { EstimatePieceCalculatorService, type CalculatedPieceCombined } from '@/estimates/calculation/estimate-piece-calculator.service';
import { InstallationWorkflowService, revisionPieceInclude, type RevisionPieceRecord } from '@/installation/installation-workflow.service';
import { agreementEstimateInclude, invalidateChangedAgreements } from '@/contracts/agreement-content';
import { refreshScheduledInstallation, synchronizeScheduleChanges } from '@/payment-plans/payment-schedule';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import { calculateMaterialFinancials } from '@/orders/order-material-financials';
import type { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { assertBeforeFactory, assertNoOpenMaterialCheckout, isBeforeFactory, ownerCanAddBeforeRemeasurement } from './material-revision-policy';
import { materialRevisionBaseHash, preserveAgreedPiecePrices, projectMaterialRevision, revisionJson, revisionProjectSummary,
  type MaterialRevisionItemSnapshot, type MaterialRevisionProposal } from './material-revision-snapshot';
import { BeginMaterialRevisionDto, MaterialRevisionDecisionDto, MaterialRevisionPieceDto } from './material-revision.dto';

const include = {
  ...agreementEstimateInclude,
  order: { include: { status: true } }, payments: true,
  pieces: { orderBy: { id: 'asc' as const }, include: { ...revisionPieceInclude, factoryUnits: { select: { lineNumber: true } } } },
  installationJob: { include: {
    measurements: { orderBy: { id: 'asc' as const } }, permit: true,
    quotes: { orderBy: { version: 'desc' as const }, take: 1, include: { lines: true, coverageSnapshot: true } },
  } },
} satisfies Prisma.EstimateInclude;
// Señal interna: fuerza el rollback completo de una simulación en MySQL.
// No se usan SAVEPOINT preparados, que no son portables a través de Prisma.
class MaterialPreviewCompleted<T> extends Error {
  constructor(readonly result: T) { super('Material preview completed'); }
}
const acceptance = 'I accept the listed material changes, quantities, prices and updated project total.';
const inputKeys = ['mark', 'idProd', 'idBrand', 'idSyst', 'idConf', 'idFC', 'width', 'height', 'heightLeft', 'heightRight',
  'legHeight', 'sashHeight', 'windowHeight', 'doorWidth', 'doorHeight', 'leftSideliteWidth', 'rightSideliteWidth',
  'leftPanels', 'rightPanels', 'panelCount', 'horizontalHeights', 'idCryst', 'idTint', 'idCoat', 'idPrivacy', 'screen',
  'highBottom', 'idActiveOption', 'idPreparationOption', 'idSillOption', 'idReinforcementOption', 'muntin', 'qty', 'dealerMarkup'];
const label = (piece: any) => `${piece.mark?.trim() || 'Unit'} · ${piece.prod?.name ?? ''} · ${piece.syst?.name ?? ''} · ${piece.conf?.conf ?? ''}`;
const summaryFields = (summary: any, dealerPricing: boolean) => summary ? {
  material: summary.material, installation: summary.installation, servicesAndFees: summary.servicesAndFees,
  projectTotal: summary.projectTotal, provisionalInstallation: summary.provisionalInstallation,
  paid: summary.paid, approvedCredit: summary.approvedCredit, balance: summary.balance, creditBalance: summary.creditBalance,
  ...(dealerPricing ? { customerProjectTotal: summary.customerProjectTotal, customerTotalIncomplete: summary.customerTotalIncomplete } : {}),
} : null;

@Injectable()
export class MaterialRevisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: EstimatePieceCalculatorService,
    private readonly installation: InstallationWorkflowService,
    private readonly promotions: PromotionsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(db: Prisma.TransactionClient, estimateId: number, actor?: AuthUser): Promise<any> {
    const estimate = await db.estimate.findUnique({ where: { id: estimateId }, include });
    if (!estimate || (actor && !isPrivileged(actor) && estimate.idUser !== actor.id))
      throw new NotFoundException('Estimate not found.');
    return estimate;
  }

  private transaction<T>(estimateId: number, work: (db: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
      const result = await work(db);
      await invalidateChangedAgreements(db, estimateId);
      return result;
    }, { maxWait: 15000, timeout: 90000 });
  }

  private async simulation<T>(estimateId: number, work: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      await this.prisma.$transaction(async db => {
        await db.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
        throw new MaterialPreviewCompleted(await work(db));
      }, { maxWait: 15000, timeout: 90000 });
    } catch (error) {
      if (error instanceof MaterialPreviewCompleted) return error.result as T;
      throw error;
    }
    throw new Error('A material simulation must never commit.');
  }

  private revisionEditToken(revision: any): string {
    return `${new Date(revision.updatedAt).toISOString()}:${JSON.stringify(revision.items)}`;
  }

  private async findRevision(db: Prisma.TransactionClient, estimateId: number, revisionId: number) {
    const revision = await db.materialRevision.findFirst({ where: { id: revisionId, estimateId } });
    if (!revision) throw new NotFoundException('Material revision not found.');
    return revision;
  }

  private editorAllowed(estimate: any, revision: any, actor: AuthUser): boolean {
    return isPrivileged(actor) || (revision.createdById === actor.id && ownerCanAddBeforeRemeasurement(estimate, actor.id));
  }

  private assertCurrent(estimate: any, revision: any) {
    assertBeforeFactory(estimate);
    assertNoOpenMaterialCheckout(estimate);
    if (materialRevisionBaseHash(estimate) !== revision.baseHash)
      throw new ConflictException('The project changed while this revision was pending. Cancel it and prepare a new revision from the current project.');
  }

  private assertEditable(estimate: any, revision: any, actor: AuthUser) {
    if (revision.status !== 'DRAFT' || revision.activeSlot !== 1)
      throw new ConflictException('This revision is no longer editable.');
    if (!this.editorAllowed(estimate, revision, actor))
      throw new ForbiddenException('Only authorized staff or the owner adding units before remeasurement can edit this revision.');
    this.assertCurrent(estimate, revision);
  }

  private async assertNoRemeasurementProposal(db: Prisma.TransactionClient, estimateId: number) {
    const pending = await db.estimateRevision.findFirst({ where: {
      estimateId, status: { in: ['DRAFT', 'PENDING_ADMIN_APPROVAL', 'PENDING_CUSTOMER_APPROVAL'] },
    }, select: { id: true } });
    if (pending) throw new ConflictException('Continue the existing remeasurement revision in Installation. Add Piece and measurement changes belong in that same revision.');
  }

  private present(estimate: any, revision: any, actor: AuthUser) {
    const dealerPricing = estimate.user.role.name === 'dealer';
    return {
      id: revision.id, version: revision.version, status: revision.status, reason: revision.reason,
      createdAt: revision.createdAt, submittedAt: revision.submittedAt, approvedAt: revision.approvedAt,
      appliedAt: revision.appliedAt, closedAt: revision.closedAt,
      requiresSignature: revision.requiresSignature,
      canEdit: revision.status === 'DRAFT' && this.editorAllowed(estimate, revision, actor),
      canApprove: revision.status === 'PENDING_APPROVAL' && estimate.idUser === actor.id,
      canCancel: revision.activeSlot === 1 && (isPrivileged(actor) || estimate.idUser === actor.id),
      original: summaryFields(revision.originalSummary, dealerPricing),
      revised: summaryFields(revision.revisedSummary, dealerPricing),
      items: (revision.items as MaterialRevisionItemSnapshot[]).map(item => ({
        key: item.key, action: item.action, originalPieceId: item.originalPieceId,
        label: item.label, originalLabel: item.originalLabel, changeDescription: item.changeDescription,
        input: { ...item.input, ...(!dealerPricing ? { dealerMarkup: 0 } : {}) },
        price: item.pricing.price, subtotal: new Decimal(item.pricing.price).mul(item.input.qty).toFixed(2),
        ...(dealerPricing ? { customerPrice: item.pricing.customerPrice,
          customerSubtotal: new Decimal(item.pricing.customerPrice).mul(item.input.qty).toFixed(2) } : {}),
      })),
    };
  }

  async get(estimateId: number, actor: AuthUser) {
    const estimate = await this.load(this.prisma, estimateId, actor);
    const revisions = await this.prisma.materialRevision.findMany({ where: { estimateId }, orderBy: { version: 'desc' }, take: 30 });
    const active = revisions.find(revision => revision.activeSlot === 1);
    const remeasurementPending = await this.prisma.estimateRevision.findFirst({ where: { estimateId, status: { in: ['DRAFT', 'PENDING_ADMIN_APPROVAL', 'PENDING_CUSTOMER_APPROVAL'] } }, select: { id: true } });
    const stageAllowed = ['Active', 'Ordered', 'Pending order review'].includes(estimate.status.name) && isBeforeFactory(estimate);
    const ownerAdd = ownerCanAddBeforeRemeasurement(estimate, actor.id);
    // En remedición, el personal continúa la misma revisión. Se conserva la
    // restricción existente: operator no recibe acceso a instalaciones ajenas.
    const installationRevisionId = !active && !estimate.order && isPrivileged(actor) &&
      (actor.role?.name === 'admin' || estimate.idUser === actor.id) &&
      estimate.installationJob && ['MEASUREMENT_SCHEDULED', 'MEASUREMENT_PENDING', 'QUOTE_DRAFT',
        'ADMIN_APPROVAL_PENDING', 'CUSTOMER_APPROVAL_PENDING'].includes(estimate.installationJob.status)
      ? estimate.installationJob.id as number : null;
    return {
      estimateId, estimateNumber: estimate.number, orderId: estimate.order?.id ?? null,
      installationId: (actor.role?.name === 'admin' || estimate.idUser === actor.id) && estimate.installationJob?.status !== 'CANCELED'
        ? estimate.installationJob?.id ?? null : null,
      installationRevisionId,
      isOwner: estimate.idUser === actor.id,
      canBegin: stageAllowed && !active && !remeasurementPending && (isPrivileged(actor) || ownerAdd),
      canReviseExisting: stageAllowed && isPrivileged(actor),
      dealerPricing: estimate.user.role.name === 'dealer',
      defaultDealerMarkup: estimate.user.role.name === 'dealer' ? Number(estimate.pieces[0]?.dealerMarkup ?? 0) * 100 : 0,
      canRequestSignature: estimate.idUser === actor.id && actor.role?.name === 'dealer',
      unavailableReason: remeasurementPending ? 'Measurement changes and additional pieces are prepared together in the existing Installation revision.' : !stageAllowed ? 'Material revisions are available only before the order is sent to the manufacturer.'
        : !isPrivileged(actor) && !ownerAdd && !active ? 'The owner can add units after the installation deposit is paid and before remeasurement begins. Contact the company for other material changes.' : null,
      pieces: estimate.pieces.map((piece: RevisionPieceRecord) => ({
        id: piece.id, label: label(piece), input: {
          ...this.installation.materialRevisionPieceInput(piece),
          ...(estimate.user.role.name !== 'dealer' ? { dealerMarkup: 0 } : {}),
        },
      })),
      current: active ? this.present(estimate, active, actor) : null,
      history: revisions.filter(revision => revision.activeSlot !== 1).map(revision => this.present(estimate, revision, actor)),
    };
  }

  async begin(estimateId: number, dto: BeginMaterialRevisionDto, actor: AuthUser) {
    await this.transaction(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      assertBeforeFactory(estimate); assertNoOpenMaterialCheckout(estimate);
      if (!isPrivileged(actor) && !ownerCanAddBeforeRemeasurement(estimate, actor.id))
        throw new ForbiddenException('The owner can add pieces only after the deposit is paid and before remeasurement starts.');
      if (estimate.order && dto.factoryNotSentConfirmed !== true)
        throw new BadRequestException('Confirm that this order has not been sent to the manufacturer.');
      await this.assertNoRemeasurementProposal(db, estimateId);
      if (await db.materialRevision.findFirst({ where: { estimateId, activeSlot: 1 } }))
        throw new ConflictException('This project already has a pending material revision. Open it instead.');
      const last = await db.materialRevision.findFirst({ where: { estimateId }, orderBy: { version: 'desc' }, select: { version: true } });
      const signed = await db.estimateAgreement.findFirst({ where: { estimateId, signedAt: { not: null } }, select: { id: true } });
      const revision = await db.materialRevision.create({ data: {
        estimateId, version: (last?.version ?? 0) + 1, activeSlot: 1, reason: dto.reason.trim(),
        baseHash: materialRevisionBaseHash(estimate), items: [], originalSummary: revisionJson(revisionProjectSummary(estimate)),
        requiresSignature: Boolean(signed), createdById: actor.id,
        factoryNotSentConfirmedAt: estimate.order ? new Date() : null,
      } });
      await this.audit(db, revision, actor.id, 'Draft created. Original specifications, payments and prices remain unchanged.');
    });
    return this.get(estimateId, actor);
  }

  private async calculate(db: Prisma.TransactionClient, estimate: any, revision: any, dto: MaterialRevisionPieceDto, actor: AuthUser) {
    this.assertEditable(estimate, revision, actor);
    const items = revision.items as MaterialRevisionItemSnapshot[];
    const existingItem = dto.itemKey ? items.find(item => item.key === dto.itemKey) : undefined;
    if (dto.itemKey && !existingItem) throw new NotFoundException('Revision item not found.');
    const originalPieceId = dto.originalPieceId ?? existingItem?.originalPieceId ?? null;
    if (existingItem && originalPieceId !== existingItem.originalPieceId)
      throw new BadRequestException('The original piece of a revision item cannot be changed.');
    if (originalPieceId && !isPrivileged(actor))
      throw new ForbiddenException('The owner can add a new piece but cannot edit already agreed material.');
    const original: RevisionPieceRecord | undefined = originalPieceId ? estimate.pieces.find((piece: any) => piece.id === originalPieceId) : undefined;
    if (originalPieceId && !original) throw new NotFoundException('Original piece not found in this estimate.');
    if (original && dto.piece.qty !== original.qty)
      throw new BadRequestException('Keep the original quantity. Add extra units with Add Piece.');
    if (!Number.isSafeInteger(dto.piece.qty) || dto.piece.qty < 1 || dto.piece.qty > 200)
      throw new BadRequestException('Quantity must be between 1 and 200 units per revision item.');
    if (original && items.some(item => item.originalPieceId === original.id && item.key !== existingItem?.key))
      throw new ConflictException('This piece is already included in the revision. Edit that revision item.');
    const input: CreatePieceDto = {
      ...dto.piece,
      mark: dto.piece.mark?.trim() ?? '',
      dealerMarkup: estimate.user.role.name !== 'dealer' ? 0 : original ? Number(original.dealerMarkup) * 100 : Number(dto.piece.dealerMarkup ?? 0),
    };
    const cache = this.calculator.createCalculationCache();
    cache.promotions = original ? savedPromotions({ promotionLockedAt: estimate.promotionLockedAt || new Date(),
      promotionContext: original.promotionSnapshot ? [original.promotionSnapshot] : [] })
      : await this.promotions.eligible(estimate.idUser, db);
    const markup = new Decimal(String(original?.markup ?? estimate.ownerMarkupSnapshot ?? 0));
    let calculated = await this.calculator.calculatePieceMetrics(input, markup, db, cache);
    if (original) {
      const prior = await this.calculator.calculatePieceMetrics(this.installation.materialRevisionPieceInput(original), markup, db, cache);
      calculated = preserveAgreedPiecePrices(original, prior, calculated);
    }
    const normalized = Object.fromEntries(inputKeys.map(key => [key, key in calculated ? calculated[key] : input[key]])) as unknown as CreatePieceDto;
    return { original, calculated, input: normalized, existingItem };
  }

  private calculatedResponse(calculated: CalculatedPieceCombined, actor: AuthUser) {
    const money = (value: any) => Number(value?.toFixed?.(2) ?? value ?? 0);
    return {
      ...Object.fromEntries(inputKeys.map(key => [key, calculated[key]])),
      rate: isPrivileged(actor) ? money(calculated.rate) : 0,
      markup: isPrivileged(actor) ? Number(calculated.markup) : 0,
      netProfit: isPrivileged(actor) ? money(calculated.netProfit) : 0,
      price: money(calculated.price), subtotal: money(calculated.subtotal),
      dealerMarkup: Number(calculated.dealerMarkupDecimal),
      customerPrice: money(calculated.customerPrice), customerSubtotal: money(calculated.customerSubtotal),
      netProfitD: money(calculated.netProfitD),
      regularPrice: money(calculated.regularPrice), regularCustomerPrice: money(calculated.regularCustomerPrice),
      promotionSnapshot: calculated.promotionSnapshot ?? null,
      dpPosPsf: money(calculated.dpPosPsf), dpNegPsf: money(calculated.dpNegPsf),
      highBottom: calculated.highBottom, highBottomPercent: calculated.highBottomPercent == null ? null : Number(calculated.highBottomPercent),
    };
  }

  async previewPiece(estimateId: number, revisionId: number, dto: MaterialRevisionPieceDto, actor: AuthUser) {
    return this.prisma.$transaction(async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      return this.calculatedResponse((await this.calculate(db, estimate, revision, dto, actor)).calculated, actor);
    }, { timeout: 60000 });
  }

  private describeChange(before: any, after: any): string[] {
    if (!before) return [`${after.qty} new unit(s)`, 'Dimensions and specifications shown in the revision item.'];
    const changes: string[] = [];
    for (const [key, text, valueKey] of [
      ['prod', 'Product', 'name'], ['bran', 'Brand', 'name'], ['syst', 'System', 'name'], ['conf', 'Configuration', 'conf'],
      ['fColor', 'Frame color', 'color'], ['cryst', 'Glass', 'glass'], ['tin', 'Glass color', 'color'],
      ['coat', 'Coating', 'name'], ['privacyOption', 'Privacy', 'name'], ['activeOption', 'Active', 'name'],
      ['preparationOption', 'Preparation', 'name'], ['sillOption', 'Sill', 'name'], ['reinforcementOption', 'Reinforcement', 'name'],
    ]) if ((before[key]?.id ?? null) !== (after[key]?.id ?? null))
      changes.push(`${text}: ${before[key]?.[valueKey] ?? 'None'} → ${after[key]?.[valueKey] ?? 'None'}`);
    for (const key of ['width', 'height', 'heightLeft', 'heightRight', 'legHeight', 'sashHeight', 'windowHeight', 'doorWidth', 'doorHeight', 'leftSideliteWidth', 'rightSideliteWidth', 'leftPanels', 'rightPanels', 'panelCount'])
      if (String(before[key] ?? '') !== String(after[key] ?? '')) changes.push(`${key}: ${before[key] ?? '—'} → ${after[key] ?? '—'}`);
    for (const key of ['screen', 'highBottom']) if (Boolean(before[key]) !== Boolean(after[key]))
      changes.push(`${key === 'screen' ? 'Screen' : 'High bottom'}: ${after[key] ? 'Yes' : 'No'}`);
    if (JSON.stringify(before.horizontalHeights ?? null) !== JSON.stringify(after.horizontalHeights ?? null))
      changes.push(`Horizontal heights: ${JSON.stringify(before.horizontalHeights ?? [])} → ${JSON.stringify(after.horizontalHeights ?? [])}`);
    const grid = (piece: any) => piece.pieceMuntin ? { patternId: piece.pieceMuntin.patternId, typeId: piece.pieceMuntin.typeId, panels: piece.pieceMuntin.panels.map((panel: any) => ({ panelIndex: panel.panelIndex, horizontalLites: panel.horizontalLites, verticalLites: panel.verticalLites })) } : null;
    if (JSON.stringify(grid(before)) !== JSON.stringify(grid(after))) changes.push('Grid specifications changed. Review the pattern, type and panel divisions.');
    if (before.mark !== after.mark) changes.push(`Mark: ${before.mark || '—'} → ${after.mark || '—'}`);
    return changes.length ? changes : ['Updated piece specifications.'];
  }

  private async buildProposal(db: Prisma.TransactionClient, estimate: any, items: MaterialRevisionItemSnapshot[], actorId: number) {
    // Se invoca exclusivamente en simulation(), cuya transacción SIEMPRE se revierte.
    // La propuesta se guarda después en otra transacción, con verificación de concurrencia.
      const changes: Array<{ key: string; piece: RevisionPieceRecord; original?: RevisionPieceRecord }> = [];
      for (const item of items) {
        const original = item.originalPieceId ? estimate.pieces.find((piece: any) => piece.id === item.originalPieceId) : undefined;
        const piece = await this.installation.persistMaterialRevisionPiece(estimate.id, item.input, item.pricing, db, original);
        changes.push({ key: item.key, piece, original });
        item.label = label(piece); item.originalLabel = original ? label(original) : null;
        item.changeDescription = this.describeChange(original, piece);
      }
      const installation = await this.installation.stageMaterialRevisionInstallation(estimate.id, changes, actorId, db);
      const staged = await this.load(db, estimate.id);
      const totals = this.calculator.calculateEstimateTotalsFromPersistedPieces(staged.pieces,
        new Decimal(String(estimate.taxRate)), new Decimal(String(estimate.customerTaxRate)));
      const proposal: MaterialRevisionProposal = {
        pieces: staged.pieces.map((piece: any) => {
          const { factoryUnits, ...record } = piece; return record;
        }),
        totals: { ...totals, units: staged.pieces.reduce((sum: number, piece: any) => sum + piece.qty, 0),
          promotionContext: staged.pieces.flatMap((piece: any) => piece.promotionSnapshot ? [piece.promotionSnapshot] : []) },
        installation,
      };
      const projected = projectMaterialRevision(estimate, { proposal });
      const summary = revisionProjectSummary(projected);
      const legacyPlan = estimate.order && !estimate.paymentPlanSnapshot &&
        summary.projectTotal !== revisionProjectSummary(estimate).projectTotal
        ? legacyMaterialRevisionPlan(estimate) : null;
      await db.estimate.update({ where: { id: estimate.id }, data: {
        ...proposal.totals,
        ...(legacyPlan ? { paymentPlanSnapshot: revisionJson(legacyPlan) } : {}),
      } });
      // La simulación de cuotas también se revierte. La firma ve el mismo
      // ajuste que luego se aplica, conservando intactas las cuotas anteriores.
      await synchronizeScheduleChanges(db, estimate.id, { approvedMaterialRevision: true });
      const terms = await db.estimate.findUniqueOrThrow({ where: { id: estimate.id }, select: { paymentPlanSnapshot: true } });
      if (terms.paymentPlanSnapshot) proposal.paymentPlanSnapshot = revisionJson(terms.paymentPlanSnapshot);
      return { proposal: revisionJson<MaterialRevisionProposal>(proposal), summary };
  }

  async savePiece(estimateId: number, revisionId: number, dto: MaterialRevisionPieceDto, actor: AuthUser) {
    const preview = await this.simulation(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      const { original, calculated, input, existingItem } = await this.calculate(db, estimate, revision, dto, actor);
      if (original && createEstimateRevisionPieceFingerprint(this.installation.materialRevisionPieceInput(original)) === createEstimateRevisionPieceFingerprint(input))
        throw new BadRequestException('No material specifications changed. Remove this pending change if it is no longer needed.');
      const items = revisionJson<MaterialRevisionItemSnapshot[]>(revision.items);
      if (!existingItem && items.length >= 100) throw new BadRequestException('A revision supports up to 100 material items.');
      const item: MaterialRevisionItemSnapshot = { key: existingItem?.key ?? randomUUID(), action: original ? 'UPDATE' : 'ADD',
        originalPieceId: original?.id ?? null, input, pricing: await this.installation.materialRevisionPricing(calculated, db),
        label: '', originalLabel: null, changeDescription: [] };
      const index = items.findIndex(candidate => candidate.key === item.key);
      if (index < 0) items.push(item); else items[index] = item;
      const result = await this.buildProposal(db, estimate, items, actor.id);
      return { items, result, editToken: this.revisionEditToken(revision), message: `${item.action === 'ADD' ? 'Added' : 'Updated'} pending revision item: ${item.label}.` };
    });
    await this.transaction(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      this.assertEditable(estimate, revision, actor);
      await this.assertNoRemeasurementProposal(db, estimateId);
      if (this.revisionEditToken(revision) !== preview.editToken)
        throw new ConflictException('Another user changed this revision. Refresh it before saving again.');
      await db.materialRevision.update({ where: { id: revisionId }, data: {
        items: revisionJson(preview.items), proposal: revisionJson(preview.result.proposal), revisedSummary: revisionJson(preview.result.summary),
      } });
      await this.audit(db, revision, actor.id, preview.message);
    });
    return this.get(estimateId, actor);
  }

  async removeItem(estimateId: number, revisionId: number, key: string, actor: AuthUser) {
    const preview = await this.simulation(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      this.assertEditable(estimate, revision, actor);
      const items = revisionJson<MaterialRevisionItemSnapshot[]>(revision.items).filter(item => item.key !== key);
      if (items.length === (revision.items as any[]).length) throw new NotFoundException('Revision item not found.');
      return { items, editToken: this.revisionEditToken(revision), result: await this.buildProposal(db, estimate, items, actor.id) };
    });
    await this.transaction(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      this.assertEditable(estimate, revision, actor);
      if (this.revisionEditToken(revision) !== preview.editToken)
        throw new ConflictException('Another user changed this revision. Refresh it before saving again.');
      await db.materialRevision.update({ where: { id: revisionId }, data: {
        items: revisionJson(preview.items), proposal: revisionJson(preview.result.proposal), revisedSummary: revisionJson(preview.result.summary),
      } });
    });
    return this.get(estimateId, actor);
  }

  async submit(estimateId: number, revisionId: number, accepted: boolean, actor: AuthUser) {
    await this.transaction(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      this.assertEditable(estimate, revision, actor);
      if (!(revision.items as any[]).length || !revision.proposal) throw new BadRequestException('Add at least one change before submitting the revision.');
      if (accepted !== true) throw new BadRequestException('Review and confirm the proposed changes and total.');
      await db.materialRevision.update({ where: { id: revisionId }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date() } });
      await this.audit(db, revision, actor.id, 'Submitted for owner approval.');
      if (estimate.idUser === actor.id) {
        await this.approve(db, estimate, { ...revision, status: 'PENDING_APPROVAL' }, actor.id);
      } else {
        await this.notifications.createAndSend({ recipientId: estimate.idUser, actorId: actor.id,
          message: `Material revision for Estimate #${estimate.number} is ready for your review.`,
          actionUrl: `/estimates/${estimateId}/material-revisions`, actionLabel: 'Review material changes',
          dedupeKey: `material-revision:${revisionId}:approval` }, db);
      }
    });
    return this.get(estimateId, actor);
  }

  private async approve(db: Prisma.TransactionClient, estimate: any, revision: any, actorId: number) {
    this.assertCurrent(estimate, revision);
    if (revision.status !== 'PENDING_APPROVAL') throw new ConflictException('This revision is not awaiting approval.');
    const signed = await db.estimateAgreement.findFirst({ where: { estimateId: estimate.id, signedAt: { not: null } }, select: { id: true } });
    const approved = await db.materialRevision.update({ where: { id: revision.id }, data: {
      status: signed ? 'AWAITING_SIGNATURE' : 'PENDING_APPROVAL', requiresSignature: Boolean(signed),
      approvedById: actorId, approvedAt: new Date(),
    } });
    await this.audit(db, revision, actorId, `${acceptance}${signed ? ' Updated customer signature required before application.' : ''}`);
    if (!signed) await this.apply(db, estimate, approved, actorId);
  }

  async decide(estimateId: number, revisionId: number, dto: MaterialRevisionDecisionDto, actor: AuthUser) {
    await this.transaction(estimateId, async db => {
      const estimate = await this.load(db, estimateId, actor);
      const revision = await this.findRevision(db, estimateId, revisionId);
      if (revision.activeSlot !== 1) throw new ConflictException('This revision is already closed.');
      if (dto.decision === 'APPROVE') {
        if (estimate.idUser !== actor.id) throw new ForbiddenException('Only the estimate owner can approve the material revision.');
        if (dto.accepted !== true) throw new BadRequestException('Accept the revised specifications and total.');
        await this.approve(db, estimate, revision, actor.id);
      } else {
        if (dto.decision === 'REJECT' && (estimate.idUser !== actor.id || revision.status !== 'PENDING_APPROVAL'))
          throw new ForbiddenException('Only the estimate owner can reject a revision awaiting approval.');
        if (dto.decision === 'CANCEL' && !isPrivileged(actor) && estimate.idUser !== actor.id)
          throw new ForbiddenException('You cannot cancel this revision.');
        await db.materialRevision.update({ where: { id: revisionId }, data: {
          status: dto.decision === 'REJECT' ? 'REJECTED' : 'CANCELED', activeSlot: null, closedAt: new Date(),
        } });
        await db.estimateAgreement.updateMany({ where: { materialRevisionId: revisionId, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
        await this.audit(db, revision, actor.id, `${dto.decision === 'REJECT' ? 'Rejected' : 'Canceled'}. Original material and payments preserved.`);
      }
    });
    return this.get(estimateId, actor);
  }

  // Se llama dentro del mismo bloqueo/transacción que registra la firma del cliente.
  async applySignedRevision(db: Prisma.TransactionClient, estimateId: number, revisionId: number, agreementId: string) {
    const revision = await this.findRevision(db, estimateId, revisionId);
    if (revision.status === 'APPLIED') return;
    if (revision.status !== 'AWAITING_SIGNATURE' || revision.activeSlot !== 1)
      throw new ConflictException('This material revision is no longer awaiting a signature.');
    const agreement = await db.estimateAgreement.findFirst({ where: { id: agreementId, estimateId, materialRevisionId: revisionId, signedAt: { not: null }, invalidatedAt: null } });
    if (!agreement) throw new ConflictException('A valid signature for this revision is required.');
    const estimate = await this.load(db, estimateId);
    this.assertCurrent(estimate, revision);
    await this.apply(db, estimate, revision, revision.approvedById ?? estimate.idUser);
  }

  private async apply(db: Prisma.TransactionClient, estimate: any, revision: any, actorId: number) {
    this.assertCurrent(estimate, revision);
    const items = revision.items as MaterialRevisionItemSnapshot[];
    const proposal = revision.proposal as MaterialRevisionProposal;
    if (!proposal || !items.length || !revision.approvedAt) throw new ConflictException('The material revision is incomplete or unapproved.');
    const changes: Array<{ key: string; piece: RevisionPieceRecord; original?: RevisionPieceRecord }> = [];
    for (const item of items) {
      const original = item.originalPieceId ? estimate.pieces.find((piece: any) => piece.id === item.originalPieceId) : undefined;
      if (item.originalPieceId && !original) throw new ConflictException('An original piece is no longer available.');
      changes.push({ key: item.key, original,
        piece: await this.installation.persistMaterialRevisionPiece(estimate.id, item.input, item.pricing, db, original) });
    }
    await this.installation.stageMaterialRevisionInstallation(estimate.id, changes, actorId, db, proposal.installation);
    await db.estimate.update({ where: { id: estimate.id }, data: {
      ...proposal.totals,
      ...(proposal.paymentPlanSnapshot ? { paymentPlanSnapshot: revisionJson(proposal.paymentPlanSnapshot) } : {}),
    } as Prisma.EstimateUpdateInput });
    const updated = await this.load(db, estimate.id);
    if (estimate.order) {
      const discount = calculateEstimateDiscount(updated);
      const customerPays = updated.dealerModeSnapshot === 'INTERNAL';
      const saleSubtotal = discount?.material.subtotal ?? (customerPays ? updated.customerPriceT : updated.priceT);
      const total = discount?.material.total ?? (customerPays ? updated.customerTotalPayable : updated.totalPayable);
      const financials = calculateMaterialFinancials({ saleSubtotal: String(saleSubtotal), factoryRate: String(updated.rateT) });
      await db.order.update({ where: { id: estimate.order.id }, data: {
        units: updated.units, amount: new Prisma.Decimal(String(total)),
        price: new Prisma.Decimal(String(saleSubtotal)), saleSubtotal: new Prisma.Decimal(String(saleSubtotal)),
        rate: updated.rateT, netProfit: new Prisma.Decimal(financials.totalProfit.toFixed(2)),
      } });
    }
    await db.materialRevision.update({ where: { id: revision.id }, data: { status: 'APPLIED', activeSlot: null, appliedAt: new Date(), closedAt: new Date() } });
    await synchronizeScheduleChanges(db, estimate.id);
    await refreshScheduledInstallation(db, estimate.id);
    await this.audit(db, revision, actorId, `Approved material revision applied to Estimate #${estimate.number}${estimate.order ? ` / Order #${estimate.order.number}` : ''}. Payments were not modified.`);
    await this.notifications.createAndSendToRoles(['admin'], {
      message: `Material revision v${revision.version} applied to Estimate #${estimate.number}.`,
      actionUrl: `/estimates/${estimate.id}/material-revisions`, actionLabel: 'Review material revision',
      dedupeKey: `material-revision:${revision.id}:applied`,
    }, { excludeUserIds: [actorId], db });
    await invalidateChangedAgreements(db, estimate.id);
  }

  private audit(db: Prisma.TransactionClient, revision: any, actorId: number, message: string) {
    return db.eventLog.create({ data: { action: 'UPDATE', entityType: 'MaterialRevision', entityId: revision.id, userId: actorId,
      message: `Material revision v${revision.version}: ${message}` } });
  }
}

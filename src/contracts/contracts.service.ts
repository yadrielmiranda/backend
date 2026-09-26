import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MaterialRevisionsService } from '@/estimates/material-revisions/material-revisions.service';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { assertCompleteEstimateCustomer } from '@/estimates/estimate-customer-details';
import {
  AgreementPricingMode,
  agreementComparison,
  agreementMatches,
  buildChangeOrder,
  canonicalJson,
  invalidateChangedAgreements,
  loadAgreementContent,
  savedAgreementScopes,
  sha256,
} from './agreement-content';
import { ContractStorageService } from './contract-storage.service';
import {
  AGREEMENT_CONSENT,
  CHANGE_ORDER_CONSENT,
  ContractPdfService,
  formatAgreementSignedAt,
  SignatureStrokes,
} from './contract-pdf.service';
import { promises as fs } from 'fs';
import { join } from 'path';

const includeContract = { contract: true } as const;
// Las consultas ordenadas solo leen metadatos: snapshot y signature pueden contener JSON grande.
const agreementSummarySelect = {
  id: true,
  revision: true,
  pricingMode: true,
  contractId: true,
  contentHash: true,
  materialRevisionId: true,
  materialHash: true,
  baseAgreementId: true,
  changeOrderNumber: true,
  quoteFileKey: true,
  signedAt: true,
  signerName: true,
  invalidatedAt: true,
  createdAt: true,
  contract: true,
} satisfies Prisma.EstimateAgreementSelect;
type AgreementSummary = Prisma.EstimateAgreementGetPayload<{
  select: typeof agreementSummarySelect;
}>;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const staleMessage =
  'This estimate changed. Ask the dealer for the updated agreement and review it before signing.';

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ContractStorageService,
    private readonly pdf: ContractPdfService,
    @Optional() private readonly materialRevisions?: MaterialRevisionsService,
  ) {}

  private transaction<T>(
    estimateId: number,
    work: (db: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        await db.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
        return work(db);
      },
      { maxWait: 15000, timeout: 90000 },
    );
  }

  private assertDealer(user: AuthUser) {
    if (user.role?.name !== 'dealer')
      throw new ForbiddenException('Only dealers can manage their contracts.');
  }

  private async ownedEstimate(
    estimateId: number,
    user: AuthUser,
    writing = false,
  ) {
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: estimateId },
      include: { user: { include: { role: true } }, status: true },
    });
    const privileged = ['admin', 'operator'].includes(user.role?.name ?? '');
    if (
      !estimate ||
      estimate.user.role.name !== 'dealer' ||
      (estimate.idUser !== user.id && !privileged)
    )
      throw new NotFoundException('Estimate not found.');
    if (
      writing &&
      (user.role?.name !== 'dealer' || estimate.idUser !== user.id)
    )
      throw new ForbiddenException(
        'Only the estimate owner can request a signature.',
      );
    return estimate;
  }

  private async publicAccess(token: string) {
    if (!token || token.length > 64)
      throw new NotFoundException('Estimate not found.');
    const estimate = await this.prisma.estimate.findFirst({
      where: {
        publicTokenEnabled: true,
        OR: [{ publicToken: token }, { publicTotalToken: token }],
      },
      include: {
        user: { select: { isActive: true, role: { select: { name: true } } } },
      },
    });
    if (
      !estimate ||
      estimate.user.role.name !== 'dealer' ||
      !estimate.user.isActive
    )
      throw new NotFoundException('Estimate not found.');
    return {
      estimate,
      pricingMode: (estimate.publicTotalToken === token
        ? 'total'
        : 'detailed') as AgreementPricingMode,
    };
  }

  private assertSignable(
    estimate: any,
    token?: string,
    mode?: AgreementPricingMode,
  ) {
    if (
      token &&
      (!estimate?.publicTokenEnabled ||
        token !==
          (mode === 'total' ? estimate.publicTotalToken : estimate.publicToken))
    )
      throw new NotFoundException('Estimate not found.');
    if (
      !['Active', 'Ordered', 'Pending order review'].includes(estimate?.status?.name) ||
      !estimate?.pieces?.length
    )
      throw new BadRequestException(
        'Only active, pending order review, or ordered estimates with pieces can be signed.',
      );
    if (
      estimate.status.name === 'Active' &&
      estimate.expiresAt &&
      new Date(estimate.expiresAt) <= new Date() &&
      !estimate.promotionLockedAt &&
      !(estimate.manualDiscount as any)?.lockedAt
    )
      throw new BadRequestException(
        'This estimate has expired. Ask the dealer to update it.',
      );
    if (!estimate.user.isActive)
      throw new BadRequestException('The dealer account is inactive.');
  }

  private contractInfo(contract: any) {
    return contract
      ? {
          id: contract.id,
          version: contract.version,
          name: contract.name,
          sizeBytes: contract.sizeBytes,
          createdAt: contract.createdAt,
        }
      : null;
  }
  private agreementInfo(agreement: AgreementSummary | null | undefined) {
    return agreement
      ? {
          id: agreement.id,
          revision: agreement.revision,
          kind: agreement.baseAgreementId ? 'CHANGE_ORDER' : 'AGREEMENT',
          baseAgreementId: agreement.baseAgreementId,
          changeOrderNumber: agreement.changeOrderNumber,
          pricingMode: agreement.pricingMode,
          contentHash: agreement.contentHash,
          materialRevisionId: agreement.materialRevisionId ?? null,
          contract: this.contractInfo(agreement.contract),
          signedAt: agreement.signedAt,
          signedAtLabel: agreement.signedAt
            ? formatAgreementSignedAt(agreement.signedAt)
            : null,
          signerName: agreement.signerName,
          invalidatedAt: agreement.invalidatedAt,
          ready: Boolean(agreement.quoteFileKey),
          createdAt: agreement.createdAt,
          state: agreement.invalidatedAt
            ? 'REQUIRES_NEW_SIGNATURE'
            : agreement.signedAt
              ? 'SIGNED'
              : agreement.quoteFileKey
                ? 'AWAITING_SIGNATURE'
                : 'PREPARING',
        }
      : null;
  }

  async dealerContract(user: AuthUser) {
    this.assertDealer(user);
    return this.contractInfo(
      await this.prisma.dealerContract.findFirst({
        where: { dealerId: user.id, isCurrent: true },
        orderBy: { version: 'desc' },
      }),
    );
  }

  async upload(user: AuthUser, file: Express.Multer.File) {
    this.assertDealer(user);
    if (!file) throw new BadRequestException('Choose a PDF contract.');
    const bytes = await this.storage.validateContract(file.buffer);
    const digest = sha256(bytes);
    const fileKey = `${digest}.pdf`;
    await this.storage.put(fileKey, bytes);
    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM User WHERE id = ${user.id} FOR UPDATE`;
      const existing = await db.dealerContract.findFirst({
        where: { dealerId: user.id, sha256: digest },
      });
      await db.dealerContract.updateMany({
        where: { dealerId: user.id, isCurrent: true },
        data: { isCurrent: false },
      });
      if (existing)
        return this.contractInfo(
          await db.dealerContract.update({
            where: { id: existing.id },
            data: { isCurrent: true },
          }),
        );
      const last = await db.dealerContract.findFirst({
        where: { dealerId: user.id },
        orderBy: { version: 'desc' },
      });
      const name =
        file.originalname.replace(/[/\\\x00-\x1f\x7f]/g, '_').slice(0, 150) ||
        'Dealer contract.pdf';
      return this.contractInfo(
        await db.dealerContract.create({
          data: {
            id: randomUUID(),
            dealerId: user.id,
            version: (last?.version ?? 0) + 1,
            name,
            fileKey,
            sha256: digest,
            sizeBytes: bytes.length,
          },
        }),
      );
    });
  }

  async removeDefault(user: AuthUser) {
    this.assertDealer(user);
    await this.prisma.dealerContract.updateMany({
      where: { dealerId: user.id, isCurrent: true },
      data: { isCurrent: false },
    });
    return { removed: true };
  }

  async dealerContractPdf(id: string, user: AuthUser) {
    this.assertDealer(user);
    const contract = await this.prisma.dealerContract.findFirst({
      where: { id, dealerId: user.id },
    });
    if (!contract) throw new NotFoundException('Contract not found.');
    return this.storage.read(contract.fileKey, contract.sha256);
  }

  async estimateInfo(
    estimateId: number,
    mode: AgreementPricingMode,
    user: AuthUser,
  ) {
    const estimate = await this.ownedEstimate(estimateId, user);
    return this.transaction(estimateId, async (db) => {
      await invalidateChangedAgreements(db, estimateId);
      const contract = await db.dealerContract.findFirst({
        where: { dealerId: estimate.idUser, isCurrent: true },
        orderBy: { version: 'desc' },
      });
      const agreements = await db.estimateAgreement.findMany({
        where: { estimateId, pricingMode: mode },
        select: agreementSummarySelect,
        orderBy: { revision: 'desc' },
      });
      const pendingMaterial = await db.estimate.findUnique({
        where: { id: estimateId },
        select: { materialRevisions: { where: { activeSlot: 1, status: 'AWAITING_SIGNATURE' }, select: { id: true }, take: 1 } },
      });
      const pendingMaterialRevisionId = pendingMaterial?.materialRevisions?.[0]?.id ?? null;
      let nextSignatureKind: 'AGREEMENT' | 'CHANGE_ORDER' | null =
        pendingMaterialRevisionId && agreements[0]?.materialRevisionId !== pendingMaterialRevisionId ? 'AGREEMENT' : null;
      if (agreements[0]?.invalidatedAt) {
        nextSignatureKind = 'AGREEMENT';
        const base = agreements.find((item) => item.signedAt);
        const current = await loadAgreementContent(db, estimateId, mode);
        const saved =
          base && savedAgreementScopes(await agreementComparison(db, base.id));
        if (
          saved &&
          current &&
          base.contractId === contract?.id &&
          saved.materialHash === current.materialHash &&
          canonicalJson(saved.charges) !== canonicalJson(current.charges)
        )
          nextSignatureKind = 'CHANGE_ORDER';
      }
      return {
        defaultContract: this.contractInfo(contract),
        current: this.agreementInfo(agreements[0]),
        nextSignatureKind,
        pendingMaterialRevisionId,
        history: agreements
          .filter((item) => item.signedAt)
          .map((item) => this.agreementInfo(item)),
      };
    });
  }

  async prepare(
    estimateId: number,
    mode: AgreementPricingMode,
    useLatestContract: boolean,
    user: AuthUser,
  ) {
    await this.ownedEstimate(estimateId, user, true);
    const prepared = await this.transaction(estimateId, async (db) => {
      await invalidateChangedAgreements(db, estimateId);
      const last = await db.estimateAgreement.findFirst({
        where: { estimateId },
        select: { contractId: true, contract: true },
        orderBy: { revision: 'desc' },
      });
      const latestContract = await db.dealerContract.findFirst({
        where: { dealerId: user.id, isCurrent: true },
        orderBy: { version: 'desc' },
      });
      const contract = useLatestContract
        ? latestContract
        : (last?.contract ?? latestContract);
      if (!contract) return null;
      const content = await loadAgreementContent(db, estimateId, mode, true);
      if (!content) throw new NotFoundException('Estimate not found.');
      this.assertSignable(content.estimate);
      assertCompleteEstimateCustomer(content.estimate, 'contract');
      const token =
        mode === 'total'
          ? content.estimate.publicTotalToken
          : content.estimate.publicToken;
      if (!token || !content.estimate.publicTokenEnabled)
        throw new BadRequestException('Create an enabled customer link first.');
      const active = await db.estimateAgreement.findFirst({
        where: { estimateId, pricingMode: mode, invalidatedAt: null,
          ...(content.materialRevisionId ? { materialRevisionId: content.materialRevisionId } : {}),
        },
        select: agreementSummarySelect,
        orderBy: { revision: 'desc' },
      });
      if (
        active?.contractId === contract.id &&
        active.quoteFileKey &&
        agreementMatches(await agreementComparison(db, active.id), content)
      )
        return { agreement: active, token, existing: true as const };
      if (
        active &&
        !active.quoteFileKey &&
        active.createdAt > new Date(Date.now() - 120000)
      )
        throw new ConflictException(
          'The agreement is being prepared. Please try again shortly.',
        );
      await db.estimateAgreement.updateMany({
        where: {
          estimateId,
          invalidatedAt: null,
          ...(content.materialRevisionId ? { materialRevisionId: content.materialRevisionId } : {}),
          ...(useLatestContract && last?.contractId !== contract.id
            ? {}
            : { pricingMode: mode }),
        },
        data: { invalidatedAt: new Date() },
      });
      const counter = await db.estimate.update({
        where: { id: estimateId },
        data: { agreementRevision: { increment: 1 } },
        select: { agreementRevision: true },
      });
      const snapshot = content.snapshot;
      snapshot.agreementRevision = counter.agreementRevision;
      const base = await db.estimateAgreement.findFirst({
        where: { estimateId, pricingMode: mode, signedAt: { not: null } },
        select: agreementSummarySelect,
        orderBy: { revision: 'desc' },
      });
      const previous =
        base && savedAgreementScopes(await agreementComparison(db, base.id));
      const chargeOnly =
        previous &&
        base.contractId === contract.id &&
        previous.materialHash === content.materialHash &&
        canonicalJson(previous.charges) !== canonicalJson(content.charges);
      let changeOrderNumber: number | null = null;
      if (chargeOnly) {
        const lastChange = await db.estimateAgreement.findFirst({
          where: { estimateId, changeOrderNumber: { not: null } },
          select: { changeOrderNumber: true },
          orderBy: { changeOrderNumber: 'desc' },
        });
        changeOrderNumber = (lastChange?.changeOrderNumber ?? 0) + 1;
        snapshot.changeOrder = buildChangeOrder(
          base,
          previous.charges,
          content.charges,
          changeOrderNumber,
          mode,
        );
      }
      // El logo se incorpora a la copia: reemplazar el branding no puede romper el documento histórico.
      if (snapshot.branding?.logoUrl) {
        try {
          const path = new URL(snapshot.branding.logoUrl, 'http://localhost')
            .pathname;
          const name = decodeURIComponent(path.split('/').pop() ?? '');
          if (
            !path.includes('/uploads/logos/') ||
            !/^[\w.-]+\.(png|jpe?g|webp)$/i.test(name)
          )
            throw new Error();
          const bytes = await fs.readFile(
            join(process.cwd(), 'uploads', 'logos', name),
          );
          const ext = name.split('.').pop()!.toLowerCase();
          snapshot.branding.logoUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytes.toString('base64')}`;
        } catch {
          throw new BadRequestException(
            'The branding logo is unavailable. Upload the logo again before requesting a signature.',
          );
        }
      }
      const agreement = await db.estimateAgreement.create({
        data: {
          id: randomUUID(),
          estimateId,
          revision: counter.agreementRevision,
          materialRevisionId: content.materialRevisionId,
          contractId: contract.id,
          pricingMode: mode,
          contentHash: content.contentHash,
          materialHash: content.materialHash,
          chargesSnapshot: json(content.charges),
          baseAgreementId: chargeOnly ? base.id : null,
          changeOrderNumber,
          consentText: chargeOnly ? CHANGE_ORDER_CONSENT : AGREEMENT_CONSENT,
          snapshot: json(snapshot),
        },
        include: includeContract,
      });
      return { agreement, token, existing: false as const };
    });
    if (!prepared) return { current: null };
    if (prepared.existing === true)
      return { current: this.agreementInfo(prepared.agreement) };
    const agreement = prepared.agreement;
    const key = `${agreement.id}.quote.pdf`;
    try {
      const bytes = agreement.baseAgreementId
        ? await this.pdf.changeOrder(agreement.snapshot)
        : await this.pdf.quote(
            agreement.snapshot,
            prepared.token,
            agreement.id,
          );
      await this.storage.put(key, bytes);
      const saved = await this.transaction(estimateId, async (db) => {
        await invalidateChangedAgreements(db, estimateId);
        const active = await db.estimateAgreement.findUnique({
          where: { id: agreement.id },
        });
        if (active?.invalidatedAt) return null;
        return db.estimateAgreement.update({
          where: { id: agreement.id },
          data: { quoteFileKey: key, quoteHash: sha256(bytes) },
          include: includeContract,
        });
      });
      if (!saved) throw new ConflictException(staleMessage);
      await this.removeSupersededUnsigned(estimateId).catch(() => {
        this.logger.warn(
          `Could not remove superseded unsigned agreements for estimate ${estimateId}.`,
        );
      });
      return { current: this.agreementInfo(saved) };
    } catch (error) {
      await this.prisma.estimateAgreement.updateMany({
        where: { id: agreement.id, signedAt: null },
        data: { invalidatedAt: new Date() },
      });
      await this.storage.removeUnsignedFile(key);
      throw error;
    }
  }

  private async removeSupersededUnsigned(estimateId: number) {
    const discarded = await this.prisma.estimateAgreement.findMany({
      where: { estimateId, signedAt: null, invalidatedAt: { not: null } },
      select: { id: true, quoteFileKey: true },
    });
    if (!discarded.length) return;
    // Las firmas se conservan. Las preparaciones reemplazadas que nunca se firmaron no necesitan duplicar PDFs.
    await this.prisma.estimateAgreement.deleteMany({
      where: {
        id: { in: discarded.map((item) => item.id) },
        signedAt: null,
        invalidatedAt: { not: null },
      },
    });
    for (const item of discarded)
      await this.storage.removeUnsignedFile(item.quoteFileKey);
  }

  async publicInfo(token: string, agreementId: string) {
    const { estimate, pricingMode } = await this.publicAccess(token);
    return this.transaction(estimate.id, async (db) => {
      await invalidateChangedAgreements(db, estimate.id);
      const selected = await db.estimateAgreement.findFirst({
        where: { id: agreementId, estimateId: estimate.id, pricingMode },
        select: { ...agreementSummarySelect, consentText: true },
      });
      if (!selected) throw new NotFoundException('Agreement not found.');
      const history = selected.signedAt ? [this.agreementInfo(selected)] : [];
      let parentId = selected.baseAgreementId;
      let revision = selected.revision;
      while (parentId) {
        const parent = await db.estimateAgreement.findFirst({
          where: {
            id: parentId,
            estimateId: estimate.id,
            pricingMode,
            signedAt: { not: null },
          },
          select: agreementSummarySelect,
        });
        if (!parent || parent.revision >= revision) break;
        history.push(this.agreementInfo(parent));
        parentId = parent.baseAgreementId;
        revision = parent.revision;
      }
      const document = selected.baseAgreementId
        ? await db.estimateAgreement.findUnique({
            where: { id: selected.id },
            select: { snapshot: true },
          })
        : null;
      return {
        current: this.agreementInfo(selected),
        history,
        changeOrder: (document?.snapshot as any)?.changeOrder ?? null,
        paymentsEnabled: estimate.dealerModeSnapshot === 'INTERNAL',
        consentText: selected.consentText ?? AGREEMENT_CONSENT,
      };
    });
  }

  private async publicAgreement(token: string, id: string) {
    const access = await this.publicAccess(token);
    const agreement = await this.prisma.estimateAgreement.findFirst({
      where: {
        id,
        estimateId: access.estimate.id,
        pricingMode: access.pricingMode,
      },
      include: includeContract,
    });
    if (!agreement) throw new NotFoundException('Agreement not found.');
    return { ...access, agreement };
  }

  async publicSnapshot(token: string, id: string) {
    return (await this.publicAgreement(token, id)).agreement.snapshot;
  }

  async publicDocument(
    token: string,
    id: string,
    kind: 'contract' | 'quote' | 'signed',
  ) {
    const { agreement } = await this.publicAgreement(token, id);
    return this.document(agreement, kind);
  }

  async ownerDocument(
    estimateId: number,
    id: string,
    kind: 'contract' | 'quote' | 'signed',
    user: AuthUser,
  ) {
    await this.ownedEstimate(estimateId, user);
    const agreement = await this.prisma.estimateAgreement.findFirst({
      where: { id, estimateId },
      include: includeContract,
    });
    if (!agreement) throw new NotFoundException('Agreement not found.');
    return this.document(agreement, kind);
  }

  private async document(
    agreement: any,
    kind: 'contract' | 'quote' | 'signed',
  ) {
    const contract = agreement.contract;
    if (kind === 'contract')
      return this.storage.read(contract.fileKey, contract.sha256);
    if (!agreement.quoteFileKey)
      throw new ConflictException('The agreement is still being prepared.');
    const quote = await this.storage.read(
      agreement.quoteFileKey,
      agreement.quoteHash,
    );
    if (kind === 'quote') return quote;
    if (!agreement.signedAt || !agreement.receiptFileKey)
      throw new NotFoundException('A signed agreement is not available.');
    const documents = [quote];
    if (!agreement.baseAgreementId)
      documents.push(
        await this.storage.read(contract.fileKey, contract.sha256),
      );
    documents.push(
      await this.storage.read(agreement.receiptFileKey, agreement.receiptHash),
    );
    return this.storage.combine(documents, agreement.signedAt);
  }

  async sign(
    token: string,
    id: string,
    input: {
      contentHash: string;
      signerName: string;
      accepted: boolean;
      signature: SignatureStrokes;
    },
    metadata: { ip?: string; userAgent?: string },
  ) {
    const { estimate, pricingMode } = await this.publicAccess(token);
    const name = input.signerName?.trim();
    if (
      !name ||
      name.length > 150 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      input.accepted !== true
    )
      throw new BadRequestException(
        'Enter your name and accept the agreement.',
      );
    this.validateSignature(input.signature);
    return this.transaction(estimate.id, async (db) => {
      const agreement = await db.estimateAgreement.findFirst({
        where: { id, estimateId: estimate.id, pricingMode },
        include: includeContract,
      });
      const current = await loadAgreementContent(db, estimate.id, pricingMode);
      this.assertSignable(current?.estimate, token, pricingMode);
      if (
        !agreement ||
        agreement.invalidatedAt ||
        agreement.contentHash !== input.contentHash ||
        !agreementMatches(agreement, current)
      )
        throw new ConflictException(staleMessage);
      // El bloqueo evita firmas duplicadas y conserva intacta la primera aceptación.
      if (agreement.signedAt) return { current: this.agreementInfo(agreement) };
      if (!agreement.quoteFileKey)
        throw new ConflictException('The agreement is still being prepared.');
      if (agreement.baseAgreementId) {
        const base = await db.estimateAgreement.findFirst({
          where: {
            id: agreement.baseAgreementId,
            estimateId: estimate.id,
            pricingMode,
            signedAt: { not: null },
          },
          select: { id: true, contractId: true, revision: true },
        });
        if (
          !base ||
          base.contractId !== agreement.contractId ||
          base.revision >= agreement.revision
        )
          throw new ConflictException(
            'The original signed agreement is unavailable.',
          );
      }
      // Se verifica la integridad de ambos documentos antes de registrar la aceptación.
      await this.storage.read(agreement.quoteFileKey, agreement.quoteHash);
      await this.storage.read(
        agreement.contract.fileKey,
        agreement.contract.sha256,
      );
      const signedAt = new Date();
      const receipt = await this.pdf.receipt({
        agreement,
        signerName: name,
        strokes: input.signature,
        signedAt,
      });
      const receiptKey = `${randomUUID()}.receipt.pdf`;
      await this.storage.put(receiptKey, receipt);
      const signed = await db.estimateAgreement.update({
        where: { id },
        data: {
          signerName: name,
          signature: json(input.signature),
          consentText: agreement.consentText ?? AGREEMENT_CONSENT,
          signedAt,
          receiptFileKey: receiptKey,
          receiptHash: sha256(receipt),
          ipAddress: metadata.ip?.slice(0, 45),
          userAgent: metadata.userAgent?.slice(0, 512),
        },
        include: includeContract,
      });
      if (agreement.materialRevisionId) {
        if (!this.materialRevisions)
          throw new ConflictException('Material revision processing is unavailable. No signature or changes were saved.');
        await this.materialRevisions.applySignedRevision(db, estimate.id, agreement.materialRevisionId, agreement.id);
        const applied = await loadAgreementContent(db, estimate.id, pricingMode);
        if (!agreementMatches(signed, applied))
          throw new ConflictException('The revised project does not match the signed document. No changes were applied.');
      }
      await db.eventLog.create({
        data: {
          action: 'CREATE',
          entityType: 'EstimateAgreement',
          entityId: estimate.id,
          message: `Estimate #${estimate.number} agreement revision ${agreement.revision} signed by ${name}.`,
        },
      });
      return { current: this.agreementInfo(signed) };
    });
  }

  private validateSignature(strokes: SignatureStrokes) {
    if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > 100)
      throw new BadRequestException('Draw your signature.');
    let count = 0,
      distance = 0;
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length > 3000)
        throw new BadRequestException('Invalid signature.');
      for (const [index, point] of stroke.entries()) {
        count++;
        if (
          !point ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          point.x < 0 ||
          point.x > 1 ||
          point.y < 0 ||
          point.y > 1
        )
          throw new BadRequestException('Invalid signature.');
        if (index)
          distance += Math.hypot(
            point.x - stroke[index - 1].x,
            point.y - stroke[index - 1].y,
          );
      }
    }
    if (count < 5 || count > 5000 || distance < 0.08)
      throw new BadRequestException('Draw your signature before continuing.');
  }
}

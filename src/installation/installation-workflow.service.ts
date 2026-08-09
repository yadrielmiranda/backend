import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EstimateRevisionChangeReason,
  EstimateRevisionItemAction,
  EstimateRevisionStatus,
  GlobalParameterKey,
  InstallationApprovalDecision,
  InstallationApprovalStage,
  InstallationAppointmentStatus,
  InstallationAppointmentType,
  InstallationJobStatus,
  InstallationLineOrigin,
  InstallationMeasurementStatus,
  InstallationPermitStatus,
  InstallationQuoteReason,
  InstallationQuoteStatus,
  OrderExtraChargeStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
  PrismaClient,
  ProductKind,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import { resolvePieceComponents } from '@/pricing/piece-component-resolver';
import { InstallationPricingService } from './installation-pricing.service';
import type { InstallationProfileSnapshot } from './installation-pricing.service';
import {
  EstimatePieceCalculatorService,
  type CalculatedPieceCombined,
} from '@/estimates/calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from '@/estimates/muntins/estimate-muntin.service';
import type { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import {
  calculateInstallationBalance,
  canOwnerEditInstallationEstimate,
  createEstimateRevisionPieceFingerprint,
  didInstallationMeasurementPricingInputChange,
  canViewAllInstallations,
  resolveApprovedPreOrderStage,
  installationSearchTokens,
} from './installation-flow-policy';
import {
  AddInstallationLineDto,
  AddInstallationMeasurementDto,
  CancelInstallationDto,
  InstallationAppointmentResponse,
  InstallationApprovalDto,
  ProposeInstallationAppointmentDto,
  ProposeInstallationMeasurementPieceDto,
  RequestInstallationDto,
  RespondInstallationAppointmentDto,
  SubmitInstallationQuoteDto,
  UpdateInstallationMeasurementDto,
  UpdateInstallationPermitDto,
} from './dto/installation-workflow.dto';
import { FindInstallationJobsQueryDto } from './dto/find-installation-jobs-query.dto';
import {
  additionalServiceInputFromStoredLine,
  additionalServicePricingDimensions,
} from './installation-additional-service';

export const INSTALLATION_DEPOSIT_TERMS =
  'Once paid, this installation deposit is non-refundable. If the installation proceeds, the full deposit is credited toward the installation balance. If the installation is canceled, the deposit is not refunded.';

const REMEASUREMENT_IN_PROGRESS_STATUSES = new Set<InstallationJobStatus>([
  InstallationJobStatus.MEASUREMENT_SCHEDULING,
  InstallationJobStatus.MEASUREMENT_SCHEDULED,
  InstallationJobStatus.MEASUREMENT_PENDING,
]);

function preserveRemeasurementStage(status: InstallationJobStatus): InstallationJobStatus {
  return status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING || REMEASUREMENT_IN_PROGRESS_STATUSES.has(status)
    ? status
    : InstallationJobStatus.QUOTE_DRAFT;
}

type PrismaTransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const quoteLineSnapshotSelect = {
  serviceId: true,
  ruleId: true,
  measurementId: true,
  origin: true,
  sourceSystemId: true,
  sourceConfigId: true,
  componentIndex: true,
  componentLabel: true,
  serviceNameSnapshot: true,
  billingUnitSnapshot: true,
  ruleMetricSnapshot: true,
  ruleSnapshot: true,
  widthIn: true,
  heightIn: true,
  areaSqFt: true,
  panelCount: true,
  lengthIn: true,
  metricValue: true,
  rate: true,
  billableQuantity: true,
  occurrences: true,
  baseAmount: true,
  adjustmentPercent: true,
  adjustedAmount: true,
  description: true,
  sortOrder: true,
} satisfies Prisma.InstallationQuoteLineSelect;

const revisionPieceInclude = {
  prod: true,
  bran: true,
  conf: true,
  syst: true,
  fColor: true,
  cryst: true,
  tin: true,
  coat: true,
  activeOption: true,
  preparationOption: true,
  sillOption: true,
  reinforcementOption: true,
  pieceMuntin: {
    include: {
      pattern: true,
      type: true,
      panels: { orderBy: { panelIndex: 'asc' as const } },
    },
  },
} satisfies Prisma.PieceInclude;

type RevisionPieceRecord = Prisma.PieceGetPayload<{
  include: typeof revisionPieceInclude;
}>;

type RevisionPiecePricingSnapshot = {
  rate: string;
  price: string;
  netProfit: string;
  markup: string;
  dealerMarkupDecimal: string;
  netProfitD: string;
  subtotal: string;
  customerPrice: string;
  customerSubtotal: string;
  dpPosPsf: string;
  dpNegPsf: string;
  highBottomPercent: string | null;
  display: {
    productName: string | null;
    brandName: string | null;
    systemName: string | null;
    configName: string | null;
    crystalName: string | null;
  };
};

const jobInclude = {
  estimate: {
    include: {
      user: { include: { role: true } },
      status: true,
      order: { include: { status: true } },
      payments: { orderBy: { createdAt: 'asc' as const } },
      pieces: {
        orderBy: { id: 'asc' as const },
        include: revisionPieceInclude,
      },
    },
  },
  requestedBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  measurements: {
    orderBy: [{ pieceId: 'asc' as const }, { unitIndex: 'asc' as const }, { id: 'asc' as const }],
  },
  quotes: {
    orderBy: { version: 'desc' as const },
    include: {
      lines: {
        orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
      },
      approvals: {
        orderBy: { createdAt: 'asc' as const },
        include: {
          actor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
        },
      },
    },
  },
  permit: true,
  payments: { orderBy: { createdAt: 'asc' as const } },
  appointments: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      proposedBy: { select: { id: true, firstName: true, lastName: true } },
      respondedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  revisions: {
    orderBy: { version: 'desc' as const },
    include: {
      items: {
        orderBy: [
          { originalPieceId: 'asc' as const },
          { sourceUnitIndex: 'asc' as const },
          { id: 'asc' as const },
        ],
      },
    },
  },
} satisfies Prisma.InstallationJobInclude;

@Injectable()
export class InstallationWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: InstallationPricingService,
    private readonly logs: LogsService,
    private readonly pieceCalculator: EstimatePieceCalculatorService,
    private readonly muntinService: EstimateMuntinService,
  ) {}

  private assertAccess(job: { estimate: { idUser: number } }, user: AuthUser): void {
    if (!canViewAllInstallations(user.role?.name) && job.estimate.idUser !== user.id) {
      throw new NotFoundException('Installation job not found.');
    }
  }

  private async getJobRecord(id: number, tx: PrismaTransactionClient | PrismaService = this.prisma) {
    return tx.installationJob.findUnique({
      where: { id },
      include: jobInclude,
    });
  }

  async findJob(id: number, user: AuthUser) {
    const job = await this.getJobRecord(id);
    if (!job) throw new NotFoundException(`Installation job #${id} not found.`);
    this.assertAccess(job, user);
    return job;
  }

  async findJobByEstimate(estimateId: number, user: AuthUser) {
    const job = await this.prisma.installationJob.findUnique({
      where: { estimateId },
      include: jobInclude,
    });
    if (!job) return null;
    this.assertAccess(job, user);
    return job;
  }

  async findJobs(query: FindInstallationJobsQueryDto, user: AuthUser) {
    const pageSize = query.pageSize ?? 25;
    const requestedPage = query.page ?? 1;
    const scope = query.scope ?? 'active';
    const filters: Prisma.InstallationJobWhereInput[] = [];

    if (!canViewAllInstallations(user.role?.name)) {
      filters.push({ estimate: { idUser: user.id } });
    }

    if (query.status) {
      filters.push({ status: query.status });
    } else if (scope === 'active') {
      filters.push({
        status: {
          notIn: [
            InstallationJobStatus.COMPLETED,
            InstallationJobStatus.CANCELED,
          ],
        },
      });
    } else if (scope === 'completed') {
      filters.push({ status: InstallationJobStatus.COMPLETED });
    } else if (scope === 'canceled') {
      filters.push({ status: InstallationJobStatus.CANCELED });
    }

    for (const token of installationSearchTokens(query.search)) {
      filters.push({
        estimate: {
          OR: [
            { number: { contains: token } },
            { name: { contains: token } },
            { customerFirstName: { contains: token } },
            { customerLastName: { contains: token } },
            { customerEmail: { contains: token } },
            { order: { number: { contains: token } } },
          ],
        },
      });
    }

    const where: Prisma.InstallationJobWhereInput = filters.length
      ? { AND: filters }
      : {};
    const total = await this.prisma.installationJob.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const items = await this.prisma.installationJob.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        estimateId: true,
        status: true,
        requestedAt: true,
        updatedAt: true,
        estimate: {
          select: {
            idUser: true,
            number: true,
            name: true,
            customerFirstName: true,
            customerLastName: true,
            customerEmail: true,
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                role: { select: { name: true } },
              },
            },
            order: { select: { id: true, number: true } },
          },
        },
        _count: { select: { measurements: true } },
        quotes: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            version: true,
            status: true,
            approvalReason: true,
            total: true,
          },
        },
        appointments: {
          where: {
            status: {
              in: [
                InstallationAppointmentStatus.PROPOSED,
                InstallationAppointmentStatus.ACCEPTED,
              ],
            },
            startsAt: { gte: new Date() },
          },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            startsAt: true,
            endsAt: true,
          },
        },
      },
    });

    return {
      items: items.map(({ _count, quotes, appointments, ...job }) => ({
        ...job,
        openings: _count.measurements,
        latestQuote: quotes[0] ?? null,
        nextAppointment: appointments[0] ?? null,
      })),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  private sourceSnapshot(piece: any): Prisma.InputJsonValue {
    return {
      pieceId: piece.id,
      mark: piece.mark,
      idProd: piece.idProd,
      idBrand: piece.idBrand,
      idSyst: piece.idSyst,
      idConf: piece.idConf,
      idFC: piece.idFC,
      idCryst: piece.idCryst ?? null,
      idTint: piece.idTint ?? null,
      idCoat: piece.idCoat ?? null,
      productName: piece.prod?.name ?? null,
      brandName: piece.bran?.name ?? null,
      systemName: piece.syst?.name ?? null,
      configName: piece.conf?.conf ?? null,
      frameColorName: piece.fColor?.color ?? null,
      crystalName: piece.cryst?.glass ?? null,
      tintName: piece.tin?.color ?? null,
      coatingName: piece.coat?.name ?? null,
      width: piece.width?.toString() ?? null,
      height: piece.height?.toString() ?? null,
      heightLeft: piece.heightLeft?.toString() ?? null,
      heightRight: piece.heightRight?.toString() ?? null,
      legHeight: piece.legHeight?.toString() ?? null,
      sashHeight: piece.sashHeight?.toString() ?? null,
      windowHeight: piece.windowHeight?.toString() ?? null,
      doorWidth: piece.doorWidth?.toString() ?? null,
      doorHeight: piece.doorHeight?.toString() ?? null,
      leftSideliteWidth: piece.leftSideliteWidth?.toString() ?? null,
      rightSideliteWidth: piece.rightSideliteWidth?.toString() ?? null,
      leftPanels: piece.leftPanels ?? null,
      rightPanels: piece.rightPanels ?? null,
      panelCount: piece.panelCount ?? null,
      horizontalHeights: Array.isArray(piece.horizontalHeights)
        ? piece.horizontalHeights.map((value: unknown) => Number(value))
        : null,
      rate: piece.rate?.toString() ?? null,
      price: piece.price?.toString() ?? null,
      customerPrice: piece.customerPrice?.toString() ?? null,
      qty: piece.qty,
    };
  }

  private measurementCreateFromPiece(piece: any, unitIndex: number) {
    return {
      pieceId: piece.id,
      unitIndex,
      label: piece.qty > 1 ? `${piece.mark} (${unitIndex}/${piece.qty})` : piece.mark,
      isManual: false,
      status: InstallationMeasurementStatus.PENDING,
      sourceSnapshot: this.sourceSnapshot(piece),
      widthIn: piece.width,
      heightIn: piece.height,
      heightLeftIn: piece.heightLeft,
      heightRightIn: piece.heightRight,
      legHeightIn: piece.legHeight,
      sashHeightIn: piece.sashHeight,
      windowHeightIn: piece.windowHeight,
      doorWidthIn: piece.doorWidth,
      doorHeightIn: piece.doorHeight,
      leftSideliteWidthIn: piece.leftSideliteWidth,
      rightSideliteWidthIn: piece.rightSideliteWidth,
      leftPanels: piece.leftPanels,
      rightPanels: piece.rightPanels,
      panelCount: piece.panelCount,
      horizontalHeights: Array.isArray(piece.horizontalHeights)
        ? piece.horizontalHeights
        : Prisma.JsonNull,
      lengthIn:
        piece.prod?.kind === ProductKind.LINEAR_MATERIAL ? piece.width : null,
    } satisfies Prisma.InstallationMeasurementUncheckedCreateWithoutJobInput;
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private pieceInputFromPersisted(
    piece: RevisionPieceRecord,
    qty = 1,
  ): CreatePieceDto {
    return {
      mark: piece.mark,
      idProd: piece.idProd,
      idBrand: piece.idBrand,
      idSyst: piece.idSyst,
      idConf: piece.idConf,
      idFC: piece.idFC,
      width: piece.width?.toString(),
      height: piece.height?.toString(),
      heightLeft: piece.heightLeft?.toString(),
      heightRight: piece.heightRight?.toString(),
      legHeight: piece.legHeight?.toString(),
      sashHeight: piece.sashHeight?.toString(),
      windowHeight: piece.windowHeight?.toString(),
      doorWidth: piece.doorWidth?.toString(),
      doorHeight: piece.doorHeight?.toString(),
      leftSideliteWidth: piece.leftSideliteWidth?.toString(),
      rightSideliteWidth: piece.rightSideliteWidth?.toString(),
      leftPanels: piece.leftPanels,
      rightPanels: piece.rightPanels,
      panelCount: piece.panelCount,
      horizontalHeights: Array.isArray(piece.horizontalHeights)
        ? piece.horizontalHeights.map((value) => Number(value))
        : undefined,
      idCryst: piece.idCryst,
      idTint: piece.idTint,
      privacy: piece.privacy,
      idCoat: piece.idCoat,
      screen: piece.screen,
      highBottom: piece.highBottom,
      idActiveOption: piece.idActiveOption,
      idPreparationOption: piece.idPreparationOption,
      idSillOption: piece.idSillOption,
      idReinforcementOption: piece.idReinforcementOption,
      muntin: piece.pieceMuntin
        ? {
            idPattern: piece.pieceMuntin.patternId,
            idType: piece.pieceMuntin.typeId,
            panels: piece.pieceMuntin.panels.map((panel) => ({
              panelIndex: panel.panelIndex,
              panelCode: panel.panelCode,
              panelLabel: panel.panelLabel,
              horizontalLites: panel.horizontalLites,
              verticalLites: panel.verticalLites,
            })),
          }
        : null,
      qty,
      dealerMarkup: Number(piece.dealerMarkup.toString()) * 100,
    };
  }

  private pieceInputFromMeasurement(
    piece: RevisionPieceRecord,
    measurement: {
      widthIn: Prisma.Decimal | null;
      heightIn: Prisma.Decimal | null;
      heightLeftIn: Prisma.Decimal | null;
      heightRightIn: Prisma.Decimal | null;
      legHeightIn: Prisma.Decimal | null;
      sashHeightIn: Prisma.Decimal | null;
      windowHeightIn: Prisma.Decimal | null;
      doorWidthIn: Prisma.Decimal | null;
      doorHeightIn: Prisma.Decimal | null;
      leftSideliteWidthIn: Prisma.Decimal | null;
      rightSideliteWidthIn: Prisma.Decimal | null;
      leftPanels: number | null;
      rightPanels: number | null;
      panelCount: number | null;
      horizontalHeights: Prisma.JsonValue | null;
      lengthIn: Prisma.Decimal | null;
    },
  ): CreatePieceDto {
    const input = this.pieceInputFromPersisted(piece, 1);
    const value = (dimension: Prisma.Decimal | null) =>
      dimension?.toString();

    input.width =
      piece.prod.kind === ProductKind.LINEAR_MATERIAL
        ? value(measurement.lengthIn)
        : value(measurement.widthIn);
    input.height = value(measurement.heightIn);
    input.heightLeft = value(measurement.heightLeftIn);
    input.heightRight = value(measurement.heightRightIn);
    input.legHeight = value(measurement.legHeightIn);
    input.sashHeight = value(measurement.sashHeightIn);
    input.windowHeight = value(measurement.windowHeightIn);
    input.doorWidth = value(measurement.doorWidthIn);
    input.doorHeight = value(measurement.doorHeightIn);
    input.leftSideliteWidth = value(measurement.leftSideliteWidthIn);
    input.rightSideliteWidth = value(measurement.rightSideliteWidthIn);
    input.leftPanels = measurement.leftPanels;
    input.rightPanels = measurement.rightPanels;
    input.panelCount = measurement.panelCount;
    input.horizontalHeights = Array.isArray(measurement.horizontalHeights)
      ? measurement.horizontalHeights.map((item) => Number(item))
      : undefined;
    return input;
  }

  private originalRevisionSnapshot(piece: RevisionPieceRecord) {
    const source = this.sourceSnapshot(piece) as Prisma.InputJsonObject;
    return this.jsonValue({
      ...source,
      pieceInput: this.pieceInputFromPersisted(piece, 1),
      pricing: {
        rate: piece.rate.toString(),
        price: piece.price.toString(),
        netProfit: piece.netProfit.toString(),
        markup: piece.markup.toString(),
        dealerMarkupDecimal: piece.dealerMarkup.toString(),
        netProfitD: new Decimal(piece.customerPrice.toString())
          .minus(piece.price.toString())
          .toFixed(2),
        subtotal: piece.price.toString(),
        customerPrice: piece.customerPrice.toString(),
        customerSubtotal: piece.customerPrice.toString(),
        dpPosPsf: piece.dpPosPsf?.toString() ?? '0',
        dpNegPsf: piece.dpNegPsf?.toString() ?? '0',
        highBottomPercent: piece.highBottomPercent?.toString() ?? null,
      },
    });
  }

  private async calculatedRevisionSnapshot(
    calculated: CalculatedPieceCombined,
    tx: PrismaTransactionClient,
  ): Promise<RevisionPiecePricingSnapshot> {
    const [product, brand, system, config, crystal] = await Promise.all([
      tx.product.findUnique({
        where: { id: calculated.idProd },
        select: { name: true },
      }),
      tx.brand.findUnique({
        where: { id: calculated.idBrand },
        select: { name: true },
      }),
      tx.system.findUnique({
        where: { id: calculated.idSyst },
        select: { name: true },
      }),
      tx.config.findUnique({
        where: { id: calculated.idConf },
        select: { conf: true },
      }),
      calculated.idCryst
        ? tx.crystal.findUnique({
            where: { id: calculated.idCryst },
            select: { glass: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      rate: calculated.rate.toFixed(2),
      price: calculated.price.toFixed(2),
      netProfit: calculated.netProfit.toFixed(2),
      markup: calculated.markup.toFixed(4),
      dealerMarkupDecimal: calculated.dealerMarkupDecimal.toFixed(4),
      netProfitD: calculated.netProfitD.toFixed(2),
      subtotal: calculated.subtotal.toFixed(2),
      customerPrice: calculated.customerPrice.toFixed(2),
      customerSubtotal: calculated.customerSubtotal.toFixed(2),
      dpPosPsf: calculated.dpPosPsf.toFixed(2),
      dpNegPsf: calculated.dpNegPsf.toFixed(2),
      highBottomPercent: calculated.highBottomPercent?.toFixed(4) ?? null,
      display: {
        productName: product?.name ?? null,
        brandName: brand?.name ?? null,
        systemName: system?.name ?? null,
        configName: config?.conf ?? null,
        crystalName: crystal?.glass ?? null,
      },
    };
  }

  private estimateTotalsSnapshot(estimate: {
    units: number;
    rateT: Prisma.Decimal;
    priceT: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    totalPayable: Prisma.Decimal;
    customerPriceT: Prisma.Decimal;
    customerTaxRate: Prisma.Decimal;
    customerTaxAmount: Prisma.Decimal;
    customerTotalPayable: Prisma.Decimal;
    netProfitD: Prisma.Decimal;
  }): Prisma.InputJsonValue {
    return {
      units: estimate.units,
      rateT: estimate.rateT.toString(),
      priceT: estimate.priceT.toString(),
      netProfit: estimate.netProfit.toString(),
      taxRate: estimate.taxRate.toString(),
      taxAmount: estimate.taxAmount.toString(),
      totalPayable: estimate.totalPayable.toString(),
      customerPriceT: estimate.customerPriceT.toString(),
      customerTaxRate: estimate.customerTaxRate.toString(),
      customerTaxAmount: estimate.customerTaxAmount.toString(),
      customerTotalPayable: estimate.customerTotalPayable.toString(),
      netProfitD: estimate.netProfitD.toString(),
    };
  }

  private async resolveEstimateOwnerMarkup(
    estimateId: number,
    tx: PrismaTransactionClient,
  ): Promise<Decimal> {
    const estimate = await tx.estimate.findUnique({
      where: { id: estimateId },
      select: {
        user: {
          select: {
            markupOverride: true,
            role: { select: { markup: true } },
          },
        },
      },
    });
    if (!estimate) throw new NotFoundException('Estimate not found.');
    return new Decimal(
      estimate.user.markupOverride?.toString() ??
        estimate.user.role.markup.toString(),
    );
  }

  private async ensureDraftRevision(
    jobId: number,
    quote: {
      id: number;
      version: number;
      approvalReason: InstallationQuoteReason;
    },
    actorId: number,
    tx: PrismaTransactionClient,
  ) {
    const existing = await tx.estimateRevision.findUnique({
      where: { quoteId: quote.id },
      include: { items: true },
    });
    if (existing) {
      if (existing.status !== EstimateRevisionStatus.DRAFT) {
        throw new BadRequestException(
          'The material revision is no longer editable.',
        );
      }
      return existing;
    }

    const job = await tx.installationJob.findUnique({
      where: { id: jobId },
      select: {
        estimateId: true,
        estimate: true,
      },
    });
    if (!job) throw new NotFoundException('Installation job not found.');

    const previousRevision = await tx.estimateRevision.findFirst({
      where: { installationJobId: jobId },
      orderBy: { version: 'desc' },
      include: { items: true },
    });
    const rejectedRevision =
      previousRevision?.status === EstimateRevisionStatus.REJECTED &&
      previousRevision.version < quote.version
        ? previousRevision
        : null;

    await tx.estimateRevision.updateMany({
      where: {
        installationJobId: jobId,
        status: EstimateRevisionStatus.DRAFT,
      },
      data: { status: EstimateRevisionStatus.SUPERSEDED },
    });

    const totals = this.estimateTotalsSnapshot(job.estimate);
    return tx.estimateRevision.create({
      data: {
        estimateId: job.estimateId,
        installationJobId: jobId,
        quoteId: quote.id,
        version: quote.version,
        status: EstimateRevisionStatus.DRAFT,
        reason: quote.approvalReason,
        originalTotals: totals,
        revisedTotals: rejectedRevision
          ? this.jsonValue(rejectedRevision.revisedTotals)
          : totals,
        createdById: actorId,
        ...(rejectedRevision
          ? {
              items: {
                create: rejectedRevision.items.map((item) => ({
                  measurementId: item.measurementId,
                  originalPieceId: item.originalPieceId,
                  sourceUnitIndex: item.sourceUnitIndex,
                  action: item.action,
                  reason: item.reason,
                  reasonNote: item.reasonNote,
                  originalSnapshot: this.jsonValue(item.originalSnapshot),
                  ...(item.proposedPieceInput == null
                    ? {}
                    : {
                        proposedPieceInput: this.jsonValue(
                          item.proposedPieceInput,
                        ),
                      }),
                  ...(item.calculatedSnapshot == null
                    ? {}
                    : {
                        calculatedSnapshot: this.jsonValue(
                          item.calculatedSnapshot,
                        ),
                      }),
                })),
              },
            }
          : {}),
      },
      include: { items: true },
    });
  }

  private async recomputeRevisionTotals(
    revisionId: number,
    tx: PrismaTransactionClient,
  ) {
    const revision = await tx.estimateRevision.findUnique({
      where: { id: revisionId },
      include: {
        items: true,
        estimate: {
          include: {
            pieces: {
              orderBy: { id: 'asc' },
              include: revisionPieceInclude,
            },
          },
        },
        installationJob: {
          include: {
            measurements: {
              where: { pieceId: { not: null }, isManual: false },
              orderBy: [{ pieceId: 'asc' }, { unitIndex: 'asc' }],
            },
          },
        },
      },
    });
    if (!revision) throw new NotFoundException('Estimate revision not found.');

    const itemByMeasurement = new Map(
      revision.items.map((item) => [item.measurementId, item]),
    );
    const measurementsByPiece = new Map<number, typeof revision.installationJob.measurements>();
    for (const measurement of revision.installationJob.measurements) {
      if (measurement.pieceId == null) continue;
      const current = measurementsByPiece.get(measurement.pieceId) ?? [];
      current.push(measurement);
      measurementsByPiece.set(measurement.pieceId, current);
    }

    const rows: Array<{
      rate: Decimal;
      price: Decimal;
      customerPrice: Decimal;
    }> = [];

    for (const piece of revision.estimate.pieces) {
      const measurements = measurementsByPiece.get(piece.id) ?? [];
      for (const measurement of measurements) {
        const item = itemByMeasurement.get(measurement.id);
        if (item?.action === EstimateRevisionItemAction.REMOVE) continue;

        const pricing = item?.calculatedSnapshot as
          | (RevisionPiecePricingSnapshot & Prisma.JsonObject)
          | null;
        rows.push({
          rate: new Decimal(pricing?.rate ?? piece.rate.toString()),
          price: new Decimal(pricing?.price ?? piece.price.toString()),
          customerPrice: new Decimal(
            pricing?.customerPrice ?? piece.customerPrice.toString(),
          ),
        });
      }

      for (let index = measurements.length; index < piece.qty; index += 1) {
        rows.push({
          rate: new Decimal(piece.rate.toString()),
          price: new Decimal(piece.price.toString()),
          customerPrice: new Decimal(piece.customerPrice.toString()),
        });
      }
    }

    const rateT = rows.reduce((sum, row) => sum.add(row.rate), new Decimal(0));
    const priceT = rows.reduce((sum, row) => sum.add(row.price), new Decimal(0));
    const customerPriceT = rows.reduce(
      (sum, row) => sum.add(row.customerPrice),
      new Decimal(0),
    );
    const taxRate = new Decimal(revision.estimate.taxRate.toString());
    const customerTaxRate = new Decimal(
      revision.estimate.customerTaxRate.toString(),
    );
    const taxAmount = priceT.mul(taxRate);
    const customerTaxAmount = customerPriceT.mul(customerTaxRate);

    const revisedTotals: Prisma.InputJsonValue = {
      units: rows.length,
      rateT: rateT.toFixed(2),
      priceT: priceT.toFixed(2),
      netProfit: priceT.minus(rateT).toFixed(2),
      taxRate: taxRate.toFixed(4),
      taxAmount: taxAmount.toFixed(2),
      totalPayable: priceT.add(taxAmount).toFixed(2),
      customerPriceT: customerPriceT.toFixed(2),
      customerTaxRate: customerTaxRate.toFixed(4),
      customerTaxAmount: customerTaxAmount.toFixed(2),
      customerTotalPayable: customerPriceT
        .add(customerTaxAmount)
        .toFixed(2),
      netProfitD: customerPriceT.minus(priceT).toFixed(2),
    };

    return tx.estimateRevision.update({
      where: { id: revisionId },
      data: { revisedTotals },
    });
  }

  private async upsertMeasuredPieceRevision(
    jobId: number,
    measurementId: number,
    quote: {
      id: number;
      version: number;
      approvalReason: InstallationQuoteReason;
    },
    actorId: number,
    tx: PrismaTransactionClient,
  ) {
    const measurement = await tx.installationMeasurement.findFirst({
      where: { id: measurementId, jobId, isManual: false },
      include: { piece: { include: revisionPieceInclude } },
    });
    if (!measurement?.piece) {
      throw new BadRequestException(
        'This field measurement is not linked to an Estimate Piece.',
      );
    }

    const revision = await this.ensureDraftRevision(
      jobId,
      quote,
      actorId,
      tx,
    );
    const effectiveMarkup = await this.resolveEstimateOwnerMarkup(
      revision.estimateId,
      tx,
    );
    const originalInput = this.pieceInputFromPersisted(measurement.piece, 1);
    const proposedInput = this.pieceInputFromMeasurement(
      measurement.piece,
      measurement,
    );
    const calculated = await this.pieceCalculator.calculatePieceMetrics(
      proposedInput,
      effectiveMarkup,
      tx,
      this.pieceCalculator.createCalculationCache(),
    );
    const pricing = await this.calculatedRevisionSnapshot(calculated, tx);
    const action =
      createEstimateRevisionPieceFingerprint(originalInput) ===
      createEstimateRevisionPieceFingerprint(proposedInput)
        ? EstimateRevisionItemAction.UNCHANGED
        : EstimateRevisionItemAction.UPDATE;

    await tx.estimateRevisionItem.upsert({
      where: {
        revisionId_measurementId: {
          revisionId: revision.id,
          measurementId,
        },
      },
      create: {
        revisionId: revision.id,
        measurementId,
        originalPieceId: measurement.pieceId,
        sourceUnitIndex: measurement.unitIndex,
        action,
        reason: EstimateRevisionChangeReason.REMEASUREMENT,
        originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
        proposedPieceInput: this.jsonValue(proposedInput),
        calculatedSnapshot: this.jsonValue(pricing),
      },
      update: {
        originalPieceId: measurement.pieceId,
        sourceUnitIndex: measurement.unitIndex,
        action,
        reason: EstimateRevisionChangeReason.REMEASUREMENT,
        reasonNote: null,
        originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
        proposedPieceInput: this.jsonValue(proposedInput),
        calculatedSnapshot: this.jsonValue(pricing),
      },
    });
    await this.recomputeRevisionTotals(revision.id, tx);
    return { revision, action };
  }

  private profileFromQuote(quote: {
    profileId: number | null;
    profileNameSnapshot: string;
    profileAdjustmentPercent: Prisma.Decimal;
    profileMinimumSnapshot: Prisma.Decimal;
  }): InstallationProfileSnapshot {
    return {
      id: quote.profileId,
      name: quote.profileNameSnapshot,
      adjustmentPercent: new Decimal(quote.profileAdjustmentPercent.toString()),
      minimumCharge: new Decimal(quote.profileMinimumSnapshot.toString()),
    };
  }

  private async ensureDraftQuote(jobId: number, actorId: number, tx: PrismaTransactionClient) {
    const activeCharge = await tx.payment.findFirst({
      where: {
        installationJobId: jobId,
        type: {
          in: [PaymentType.INSTALLATION_DEPOSIT, PaymentType.MATERIAL, PaymentType.INSTALLATION],
        },
        status: PaymentStatus.PENDING,
        stripeSessionId: { not: null },
      },
      select: { type: true },
    });
    if (activeCharge) {
      throw new BadRequestException(`Cancel the active ${activeCharge.type.toLowerCase()} checkout before changing the installation quote.`);
    }

    const latest = await tx.installationQuote.findFirst({
      where: { jobId },
      orderBy: { version: 'desc' },
      include: {
        lines: { select: quoteLineSnapshotSelect, orderBy: { id: 'asc' } },
      },
    });

    if (!latest) {
      throw new BadRequestException('Installation quote was not initialized.');
    }
    if (latest.status === InstallationQuoteStatus.DRAFT) return latest;

    if (latest.status !== InstallationQuoteStatus.APPROVED && latest.status !== InstallationQuoteStatus.SUPERSEDED) {
      await tx.installationQuote.update({
        where: { id: latest.id },
        data: { status: InstallationQuoteStatus.SUPERSEDED },
      });
    }

    const context = await tx.installationJob.findUnique({
      where: { id: jobId },
      select: {
        permit: { select: { status: true } },
        estimate: { select: { order: { select: { id: true } } } },
      },
    });
    const approvalReason = context?.estimate.order
      ? InstallationQuoteReason.FIELD_CHANGE
      : context?.permit?.status === InstallationPermitStatus.CHANGES_REQUIRED
        ? InstallationQuoteReason.PERMIT_REVISION
        : InstallationQuoteReason.REMEASUREMENT;

    return tx.installationQuote.create({
      data: {
        jobId,
        version: latest.version + 1,
        status: InstallationQuoteStatus.DRAFT,
        approvalReason,
        profileId: latest.profileId,
        profileNameSnapshot: latest.profileNameSnapshot,
        profileAdjustmentPercent: latest.profileAdjustmentPercent,
        profileMinimumSnapshot: latest.profileMinimumSnapshot,
        baseSubtotal: latest.baseSubtotal,
        adjustedSubtotal: latest.adjustedSubtotal,
        serviceMinimumAdjustment: latest.serviceMinimumAdjustment,
        serviceMinimumsSnapshot: latest.serviceMinimumsSnapshot === null ? Prisma.JsonNull : (latest.serviceMinimumsSnapshot as Prisma.InputJsonValue),
        minimumAdjustment: latest.minimumAdjustment,
        total: latest.total,
        notes: latest.notes,
        createdById: actorId,
        lines: {
          create: latest.lines.map((line) => ({
            ...line,
            ruleSnapshot: line.ruleSnapshot === null ? Prisma.JsonNull : (line.ruleSnapshot as Prisma.InputJsonValue),
          })),
        },
      },
      include: {
        lines: { select: quoteLineSnapshotSelect, orderBy: { id: 'asc' } },
      },
    });
  }

  private async recalculateQuoteTotals(quoteId: number, tx: PrismaTransactionClient) {
    const quote = await tx.installationQuote.findUnique({
      where: { id: quoteId },
      include: {
        lines: {
          select: {
            serviceId: true,
            serviceNameSnapshot: true,
            baseAmount: true,
            adjustedAmount: true,
            service: { select: { minimumCharge: true } },
          },
        },
      },
    });
    if (!quote) throw new NotFoundException(`Installation quote #${quoteId} not found.`);

    const baseSubtotal = quote.lines.reduce((total, line) => total.add(line.baseAmount.toString()), new Decimal(0));
    const adjustedSubtotal = quote.lines.reduce((total, line) => total.add(line.adjustedAmount.toString()), new Decimal(0));
    const serviceMinimums = this.pricing.calculateServiceMinimums(
      quote.lines.map((line) => ({
        serviceId: line.serviceId,
        serviceName: line.serviceNameSnapshot,
        minimumCharge: line.service.minimumCharge,
        adjustedAmount: line.adjustedAmount,
      })),
    );
    const subtotalAfterServiceMinimums = adjustedSubtotal.add(serviceMinimums.totalAdjustment);

    const previouslyApproved = await tx.installationQuote.findFirst({
      where: {
        jobId: quote.jobId,
        version: { lt: quote.version },
        status: {
          in: [InstallationQuoteStatus.APPROVED, InstallationQuoteStatus.SUPERSEDED],
        },
        approvedAt: { not: null },
      },
      orderBy: { version: 'desc' },
      select: { minimumAdjustment: true },
    });

    const minimumAdjustment = previouslyApproved
      ? new Decimal(previouslyApproved.minimumAdjustment.toString())
      : Decimal.max(0, new Decimal(quote.profileMinimumSnapshot.toString()).minus(subtotalAfterServiceMinimums));
    const total = subtotalAfterServiceMinimums.add(minimumAdjustment);

    return tx.installationQuote.update({
      where: { id: quoteId },
      data: {
        baseSubtotal: new Prisma.Decimal(baseSubtotal.toFixed(2)),
        adjustedSubtotal: new Prisma.Decimal(adjustedSubtotal.toFixed(2)),
        serviceMinimumAdjustment: new Prisma.Decimal(serviceMinimums.totalAdjustment.toFixed(2)),
        serviceMinimumsSnapshot: serviceMinimums.snapshot.length === 0 ? Prisma.JsonNull : (serviceMinimums.snapshot as Prisma.InputJsonValue),
        minimumAdjustment: new Prisma.Decimal(minimumAdjustment.toFixed(2)),
        total: new Prisma.Decimal(total.toFixed(2)),
      },
    });
  }

  private async markQuoteForRecalculation(
    quoteId: number,
    tx: PrismaTransactionClient,
  ) {
    await tx.installationQuote.update({
      where: { id: quoteId },
      data: { needsRecalculation: true },
    });
  }

  private async rebuildAutomaticLines(jobId: number, quoteId: number, tx: PrismaTransactionClient) {
    const quote = await tx.installationQuote.findUnique({
      where: { id: quoteId },
    });
    if (!quote || quote.status !== InstallationQuoteStatus.DRAFT) {
      throw new BadRequestException('Only a draft quote can be recalculated.');
    }

    await tx.installationQuoteLine.deleteMany({
      where: { quoteId, origin: InstallationLineOrigin.AUTO },
    });

    const measurements = await tx.installationMeasurement.findMany({
      where: { jobId, pieceId: { not: null } },
      include: {
        piece: {
          include: {
            conf: true,
          },
        },
      },
      orderBy: [{ pieceId: 'asc' }, { unitIndex: 'asc' }],
    });
    const materialRevision = await tx.estimateRevision.findUnique({
      where: { quoteId },
      include: { items: true },
    });
    const revisionItemByMeasurement = new Map(
      (materialRevision?.items ?? []).map((item) => [
        item.measurementId,
        item,
      ]),
    );

    const profile = this.profileFromQuote(quote);
    let sortOrder = 0;

    for (const measurement of measurements) {
      const piece = measurement.piece;
      if (!piece) continue;
      const revisionItem = revisionItemByMeasurement.get(measurement.id);
      if (revisionItem?.action === EstimateRevisionItemAction.REMOVE) continue;
      const proposedPiece = revisionItem?.proposedPieceInput as
        | (Prisma.JsonObject & {
            idSyst?: number;
            idConf?: number;
            mark?: string;
          })
        | null;
      const sourceSystemId = Number(proposedPiece?.idSyst ?? piece.idSyst);
      const sourceConfigId = Number(proposedPiece?.idConf ?? piece.idConf);
      const sourceMark = String(proposedPiece?.mark ?? piece.mark);

      const sysConf = await tx.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: sourceSystemId,
            idConfig: sourceConfigId,
          },
        },
        include: {
          config: true,
          installationServices: {
            include: {
              service: { include: { rules: true } },
            },
            orderBy: [{ sortOrder: 'asc' }, { serviceId: 'asc' }],
          },
          pricingComponents: {
            orderBy: { componentType: 'asc' },
            include: {
              sourceSysConf: {
                include: {
                  config: true,
                  installationServices: {
                    include: {
                      service: { include: { rules: true } },
                    },
                    orderBy: [{ sortOrder: 'asc' }, { serviceId: 'asc' }],
                  },
                },
              },
            },
          },
        },
      });

      if (!sysConf) {
        throw new BadRequestException(`System configuration is missing for piece "${sourceMark}".`);
      }

      let components;
      try {
        components = resolvePieceComponents({
          idSystem: sourceSystemId,
          idConfig: sourceConfigId,
          configName: sysConf.config.conf,
          dimensionMode: sysConf.dimensionMode,
          pricingComponents: sysConf.pricingComponents.map((component) => ({
            componentType: component.componentType,
            sourceConfigId: component.sourceConfigId,
            quantity: component.quantity,
            sourceSysConf: {
              config: { conf: component.sourceSysConf.config.conf },
            },
          })),
          width: measurement.widthIn,
          height: measurement.heightIn,
          heightLeft: measurement.heightLeftIn,
          heightRight: measurement.heightRightIn,
          legHeight: measurement.legHeightIn,
          doorWidth: measurement.doorWidthIn,
          doorHeight: measurement.doorHeightIn,
          leftSideliteWidth: measurement.leftSideliteWidthIn,
          rightSideliteWidth: measurement.rightSideliteWidthIn,
          leftPanels: measurement.leftPanels,
          rightPanels: measurement.rightPanels,
          panelCount: measurement.panelCount,
          lengthIn: measurement.lengthIn,
        });
      } catch (error) {
        throw new BadRequestException(`Unable to resolve piece "${sourceMark}": ${error instanceof Error ? error.message : String(error)}`);
      }

      for (const component of components) {
        const mappings =
          sysConf.pricingComponents.length === 0
            ? sysConf.installationServices
            : (sysConf.pricingComponents.find((candidate) => candidate.sourceConfigId === component.idConfig)?.sourceSysConf.installationServices ?? []);

        for (const mapping of mappings) {
          if (!mapping.service.isActive) continue;

          const line = this.pricing.calculateLine({
            service: mapping.service,
            profile,
            origin: InstallationLineOrigin.AUTO,
            dimensions: {
              widthIn: component.widthIn,
              heightIn: component.heightIn,
              heightLeftIn: component.heightLeftIn,
              heightRightIn: component.heightRightIn,
              legHeightIn: component.legHeightIn,
              panelCount: component.panelCount,
              lengthIn: component.lengthIn,
              configName: component.configName,
            },
            measurementId: measurement.id,
            sourceSystemId: component.idSystem,
            sourceConfigId: component.idConfig,
            componentIndex: component.componentIndex,
            componentLabel: component.componentLabel,
            sortOrder: sortOrder++,
          });

          await tx.installationQuoteLine.create({
            data: { quoteId, ...line },
          });
        }
      }
    }
  }

  private async rebuildManualLines(
    quoteId: number,
    tx: PrismaTransactionClient,
  ) {
    const lines = await tx.installationQuoteLine.findMany({
      where: {
        quoteId,
        origin: { not: InstallationLineOrigin.AUTO },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        serviceId: true,
        origin: true,
        widthIn: true,
        heightIn: true,
        areaSqFt: true,
        panelCount: true,
        lengthIn: true,
        occurrences: true,
        description: true,
      },
    });
    if (lines.length === 0) return;

    await tx.installationQuoteLine.deleteMany({
      where: { id: { in: lines.map((line) => line.id) } },
    });

    for (const line of lines) {
      await this.addLineInTransaction(
        quoteId,
        additionalServiceInputFromStoredLine(line),
        line.origin,
        tx,
      );
    }
  }

  private async addLineInTransaction(
    quoteId: number,
    dto: AddInstallationLineDto,
    origin: InstallationLineOrigin,
    tx: PrismaTransactionClient,
  ) {
    const quote = await tx.installationQuote.findUnique({
      where: { id: quoteId },
    });
    if (!quote || quote.status !== InstallationQuoteStatus.DRAFT) {
      throw new BadRequestException('Services can only be added to a draft quote.');
    }

    const service = await tx.installationService.findUnique({
      where: { id: dto.serviceId },
      include: { rules: true },
    });
    if (!service || !service.isActive) {
      throw new BadRequestException('The selected installation service is unavailable.');
    }
    if (origin === InstallationLineOrigin.USER_SELECTED && !service.availableForRequest) {
      throw new BadRequestException('The selected service is not available for initial requests.');
    }
    if (origin === InstallationLineOrigin.FIELD_ADDED && !service.availableForField) {
      throw new BadRequestException('The selected service is not available for field additions.');
    }

    const profile = this.profileFromQuote(quote);
    const maxSort = await tx.installationQuoteLine.aggregate({
      where: { quoteId },
      _max: { sortOrder: true },
    });

    const line = this.pricing.calculateLine({
      service,
      profile,
      origin,
      dimensions: additionalServicePricingDimensions(dto),
      occurrences: dto.occurrences ?? 1,
      measurementId: null,
      sourceSystemId: null,
      sourceConfigId: null,
      componentLabel: null,
      description: dto.description,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    });

    return tx.installationQuoteLine.create({
      data: { quoteId, ...line },
    });
  }

  async requestInstallation(estimateId: number, dto: RequestInstallationDto, user: AuthUser) {
    const createdJob = await this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          status: true,
          order: true,
          payments: true,
          installationJob: true,
          user: { include: { role: true } },
          pieces: {
            orderBy: { id: 'asc' },
            include: revisionPieceInclude,
          },
        },
      });

      if (!estimate || (!canViewAllInstallations(user.role?.name) && estimate.idUser !== user.id)) {
        throw new NotFoundException(`Estimate #${estimateId} not found.`);
      }
      if (estimate.installationJob) {
        throw new ConflictException('Installation has already been requested for this estimate.');
      }
      if (estimate.status.name !== 'Active' || estimate.order) {
        throw new BadRequestException('Installation can only be requested for an active unpaid estimate.');
      }
      if (estimate.payments.some((payment) => payment.status === PaymentStatus.PAID || payment.stripeSessionId)) {
        throw new BadRequestException('Installation cannot be requested after checkout has started.');
      }
      if (estimate.pieces.length === 0) {
        throw new BadRequestException('Add at least one piece before requesting installation.');
      }

      const useEstimateCustomer = estimate.user.role.name === 'dealer';
      const contactFirstName = useEstimateCustomer ? estimate.customerFirstName : estimate.user.firstName;
      const contactLastName = useEstimateCustomer ? estimate.customerLastName : estimate.user.lastName;
      const contactEmail = useEstimateCustomer ? estimate.customerEmail : estimate.user.email;
      const contactPhone = useEstimateCustomer ? estimate.customerPhone : estimate.user.phone;
      const street = useEstimateCustomer ? estimate.customerStreet : estimate.user.street;
      const city = useEstimateCustomer ? estimate.customerCity : estimate.user.city;
      const state = useEstimateCustomer ? estimate.customerState : estimate.user.state;
      const postalCode = useEstimateCustomer ? estimate.customerPostalCode : estimate.user.postalCode;
      if (!contactFirstName || !contactLastName || (!contactEmail && !contactPhone) || !street || !city || !state || !postalCode) {
        throw new BadRequestException('Complete the installation contact and address before requesting installation pricing.');
      }

      const profile = await this.pricing.resolveProfileForUser(estimate.idUser, tx);
      const depositParameter = await tx.globalParameter.findUnique({
        where: { key: GlobalParameterKey.INSTALLATION_DEPOSIT },
      });
      const depositAmount = new Decimal(depositParameter?.value.toString() ?? 0);
      if (depositAmount.lte(0)) {
        throw new BadRequestException('Configure a positive Installation Deposit before accepting installation requests.');
      }

      let permitFee: Prisma.Decimal | null = null;
      if (dto.permitRequested) {
        const parameter = await tx.globalParameter.findUnique({
          where: { key: GlobalParameterKey.INSTALLATION_PERMIT_FEE },
        });
        if (!parameter || new Decimal(parameter.value.toString()).lte(0)) {
          throw new BadRequestException('Configure a positive Installation Permit Fee before requesting a permit.');
        }
        permitFee = parameter.value;
      }

      const job = await tx.installationJob.create({
        data: {
          estimateId,
          requestedById: user.id,
          status: InstallationJobStatus.DEPOSIT_PAYMENT_PENDING,
          depositAmountSnapshot: new Prisma.Decimal(depositAmount.toFixed(2)),
          depositTermsSnapshot: INSTALLATION_DEPOSIT_TERMS,
          measurements: {
            create: estimate.pieces.flatMap((piece) => Array.from({ length: piece.qty }, (_, index) => this.measurementCreateFromPiece(piece, index + 1))),
          },
          ...(permitFee
            ? {
                permit: {
                  create: {
                    status: InstallationPermitStatus.PAYMENT_PENDING,
                    permitFeeSnapshot: permitFee,
                  },
                },
              }
            : {}),
          quotes: {
            create: {
              version: 1,
              status: InstallationQuoteStatus.DRAFT,
              approvalReason: InstallationQuoteReason.REMEASUREMENT,
              profileId: profile.id,
              profileNameSnapshot: profile.name,
              profileAdjustmentPercent: new Prisma.Decimal(profile.adjustmentPercent.toFixed(4)),
              profileMinimumSnapshot: new Prisma.Decimal(profile.minimumCharge.toFixed(2)),
              createdById: user.id,
            },
          },
        },
        include: { quotes: true, measurements: true },
      });

      const quote = job.quotes[0];
      await this.rebuildAutomaticLines(job.id, quote.id, tx);

      for (const selected of dto.selectedServices ?? []) {
        await this.addLineInTransaction(
          quote.id,
          selected,
          InstallationLineOrigin.USER_SELECTED,
          tx,
        );
      }

      const preliminaryQuote = await this.recalculateQuoteTotals(quote.id, tx);
      const lineCount = await tx.installationQuoteLine.count({
        where: { quoteId: quote.id },
      });
      if (lineCount === 0 || new Decimal(preliminaryQuote.total.toString()).lte(0)) {
        throw new BadRequestException('No installation price could be calculated for this estimate. Review the installation-service mappings.');
      }
      if (depositAmount.gt(preliminaryQuote.total.toString())) {
        throw new BadRequestException('The Installation Deposit cannot exceed the preliminary installation total.');
      }
      return job;
    });

    await this.logs.log({
      action: 'CREATE',
      entityType: 'InstallationJob',
      entityId: createdJob.id,
      userId: user.id,
      message: `Installation requested for Estimate #${estimateId}.`,
      after: {
        estimateId,
        permitRequested: dto.permitRequested === true,
        depositAmount: createdJob.depositAmountSnapshot.toString(),
      },
    });
    return this.findJob(createdJob.id, user);
  }

  async cancelInstallation(jobId: number, dto: CancelInstallationDto, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (job.status === InstallationJobStatus.CANCELED) return job;
    if (job.status === InstallationJobStatus.IN_PROGRESS || job.status === InstallationJobStatus.COMPLETED) {
      throw new BadRequestException('An installation in progress or completed cannot be canceled.');
    }

    const activeCheckout = job.payments.find((payment) => payment.status === PaymentStatus.PENDING && Boolean(payment.stripeSessionId));
    if (activeCheckout) {
      throw new BadRequestException(`Cancel the active ${activeCheckout.type.toLowerCase()} checkout before canceling installation.`);
    }

    const depositPaid = job.payments.some((payment) => payment.type === PaymentType.INSTALLATION_DEPOSIT && payment.status === PaymentStatus.PAID);
    const installationPaid = job.payments.some((payment) => payment.type === PaymentType.INSTALLATION && payment.status === PaymentStatus.PAID);

    if (!depositPaid) {
      if (!isPrivileged(user) && job.estimate.idUser !== user.id) {
        throw new NotFoundException('Installation job not found.');
      }
      await this.prisma.installationJob.delete({ where: { id: jobId } });
      await this.logs.log({
        action: 'DELETE',
        entityType: 'InstallationJob',
        entityId: jobId,
        userId: user.id,
        message: `Installation request removed from Estimate #${job.estimate.number} before deposit payment.`,
        before: { estimateId: job.estimateId, status: job.status },
      });
      return null;
    }

    if (!isPrivileged(user)) {
      throw new BadRequestException('After the non-refundable deposit is paid, only company staff can cancel installation.');
    }
    if (installationPaid) {
      throw new BadRequestException('Installation cannot be canceled after its balance has been paid.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.installationAppointment.updateMany({
        where: {
          jobId,
          status: {
            in: [InstallationAppointmentStatus.PROPOSED, InstallationAppointmentStatus.ACCEPTED, InstallationAppointmentStatus.RESCHEDULE_REQUESTED],
          },
        },
        data: { status: InstallationAppointmentStatus.CANCELED },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status: InstallationJobStatus.CANCELED,
          canceledAt: new Date(),
          cancellationReason: dto.reason?.trim() || null,
        },
      });
    });

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'InstallationJob',
      entityId: jobId,
      userId: user.id,
      message: `Installation canceled for Estimate #${job.estimate.number}; the paid deposit remains non-refundable.`,
      before: { status: job.status },
      after: {
        status: InstallationJobStatus.CANCELED,
        cancellationReason: dto.reason?.trim() || null,
      },
    });
    return this.findJob(jobId, user);
  }

  private async assertRemeasurementCanBeRecorded(jobId: number, tx: PrismaTransactionClient) {
    const job = await tx.installationJob.findUnique({
      where: { id: jobId },
      select: {
        depositAmountSnapshot: true,
        payments: {
          where: {
            type: PaymentType.INSTALLATION_DEPOSIT,
            status: PaymentStatus.PAID,
          },
          select: { id: true },
          take: 1,
        },
        appointments: {
          where: {
            type: InstallationAppointmentType.REMEASUREMENT,
            status: {
              in: [InstallationAppointmentStatus.ACCEPTED, InstallationAppointmentStatus.COMPLETED],
            },
          },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!job) throw new NotFoundException('Installation job not found.');

    // Jobs created before deposits existed keep their original workflow.
    if (new Decimal(job.depositAmountSnapshot.toString()).eq(0)) return;
    if (job.payments.length === 0) {
      throw new BadRequestException('The non-refundable installation deposit must be paid before remeasurement.');
    }
    if (job.appointments.length === 0) {
      throw new BadRequestException('The customer must accept the remeasurement schedule before measurements are recorded.');
    }
  }

  private async updateRemeasurementProgress(jobId: number, tx: PrismaTransactionClient) {
    const pendingMeasurements = await tx.installationMeasurement.count({
      where: { jobId, status: InstallationMeasurementStatus.PENDING },
    });
    if (pendingMeasurements === 0) {
      await tx.installationAppointment.updateMany({
        where: {
          jobId,
          type: InstallationAppointmentType.REMEASUREMENT,
          status: InstallationAppointmentStatus.ACCEPTED,
        },
        data: { status: InstallationAppointmentStatus.COMPLETED },
      });
    }
    await tx.installationJob.update({
      where: { id: jobId },
      data: {
        status: pendingMeasurements === 0 ? InstallationJobStatus.QUOTE_DRAFT : InstallationJobStatus.MEASUREMENT_PENDING,
      },
    });
  }

  async addMeasurement(jobId: number, dto: AddInstallationMeasurementDto, user: AuthUser) {
    await this.findJob(jobId, user);
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can add field measurements.');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRemeasurementCanBeRecorded(jobId, tx);
      await this.ensureDraftQuote(jobId, user.id, tx);
      await tx.installationMeasurement.create({
        data: {
          jobId,
          pieceId: null,
          unitIndex: dto.unitIndex ?? 1,
          label: dto.label.trim(),
          isManual: true,
          status: InstallationMeasurementStatus.COMPLETED,
          widthIn: dto.widthIn,
          heightIn: dto.heightIn,
          heightLeftIn: dto.heightLeftIn,
          heightRightIn: dto.heightRightIn,
          legHeightIn: dto.legHeightIn,
          sashHeightIn: dto.sashHeightIn,
          windowHeightIn: dto.windowHeightIn,
          doorWidthIn: dto.doorWidthIn,
          doorHeightIn: dto.doorHeightIn,
          leftSideliteWidthIn: dto.leftSideliteWidthIn,
          rightSideliteWidthIn: dto.rightSideliteWidthIn,
          leftPanels: dto.leftPanels,
          rightPanels: dto.rightPanels,
          panelCount: dto.panelCount,
          horizontalHeights:
            dto.horizontalHeights === undefined
              ? Prisma.JsonNull
              : this.jsonValue(dto.horizontalHeights),
          lengthIn: dto.lengthIn,
          notes: dto.notes?.trim() || null,
          measuredById: user.id,
          measuredAt: new Date(),
        },
      });
      await this.updateRemeasurementProgress(jobId, tx);
    });
    return this.findJob(jobId, user);
  }

  async updateMeasurement(jobId: number, measurementId: number, dto: UpdateInstallationMeasurementDto, user: AuthUser) {
    await this.findJob(jobId, user);
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can record field measurements.');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRemeasurementCanBeRecorded(jobId, tx);
      const existing = await tx.installationMeasurement.findFirst({
        where: { id: measurementId, jobId },
      });
      if (!existing) throw new NotFoundException('Installation measurement not found.');

      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      await tx.installationMeasurement.update({
        where: { id: measurementId },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.unitIndex !== undefined ? { unitIndex: dto.unitIndex } : {}),
          ...(dto.widthIn !== undefined ? { widthIn: dto.widthIn } : {}),
          ...(dto.heightIn !== undefined ? { heightIn: dto.heightIn } : {}),
          ...(dto.heightLeftIn !== undefined ? { heightLeftIn: dto.heightLeftIn } : {}),
          ...(dto.heightRightIn !== undefined ? { heightRightIn: dto.heightRightIn } : {}),
          ...(dto.legHeightIn !== undefined ? { legHeightIn: dto.legHeightIn } : {}),
          ...(dto.sashHeightIn !== undefined ? { sashHeightIn: dto.sashHeightIn } : {}),
          ...(dto.windowHeightIn !== undefined ? { windowHeightIn: dto.windowHeightIn } : {}),
          ...(dto.doorWidthIn !== undefined ? { doorWidthIn: dto.doorWidthIn } : {}),
          ...(dto.doorHeightIn !== undefined ? { doorHeightIn: dto.doorHeightIn } : {}),
          ...(dto.leftSideliteWidthIn !== undefined ? { leftSideliteWidthIn: dto.leftSideliteWidthIn } : {}),
          ...(dto.rightSideliteWidthIn !== undefined ? { rightSideliteWidthIn: dto.rightSideliteWidthIn } : {}),
          ...(dto.leftPanels !== undefined ? { leftPanels: dto.leftPanels } : {}),
          ...(dto.rightPanels !== undefined ? { rightPanels: dto.rightPanels } : {}),
          ...(dto.panelCount !== undefined ? { panelCount: dto.panelCount } : {}),
          ...(dto.horizontalHeights !== undefined
            ? { horizontalHeights: this.jsonValue(dto.horizontalHeights) }
            : {}),
          ...(dto.lengthIn !== undefined ? { lengthIn: dto.lengthIn } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          status: InstallationMeasurementStatus.COMPLETED,
          measuredById: user.id,
          measuredAt: new Date(),
        },
      });

      if (!existing.isManual) {
        const revisionResult = await this.upsertMeasuredPieceRevision(
          jobId,
          measurementId,
          quote,
          user.id,
          tx,
        );
        if (
          revisionResult.action !== EstimateRevisionItemAction.UNCHANGED
        ) {
          await this.markQuoteForRecalculation(quote.id, tx);
        }
      } else if (
        didInstallationMeasurementPricingInputChange(existing, dto)
      ) {
        const linkedLine = await tx.installationQuoteLine.findFirst({
          where: { quoteId: quote.id, measurementId },
          select: { id: true },
        });
        if (linkedLine) {
          await this.markQuoteForRecalculation(quote.id, tx);
        }
      }
      await this.updateRemeasurementProgress(jobId, tx);
    });
    return this.findJob(jobId, user);
  }

  async proposeMeasurementPiece(
    jobId: number,
    measurementId: number,
    dto: ProposeInstallationMeasurementPieceDto,
    user: AuthUser,
  ) {
    const job = await this.findJob(jobId, user);
    if (!isPrivileged(user)) {
      throw new BadRequestException(
        'Only company staff can propose material changes.',
      );
    }
    if (job.estimate.order) {
      throw new BadRequestException(
        'Estimate material cannot be revised after the Order is created.',
      );
    }
    if (
      dto.action !== EstimateRevisionItemAction.REPLACE &&
      dto.action !== EstimateRevisionItemAction.REMOVE
    ) {
      throw new BadRequestException(
        'Use REPLACE or REMOVE for a technician-proposed Piece change.',
      );
    }
    if (dto.reason === EstimateRevisionChangeReason.OTHER && !dto.note?.trim()) {
      throw new BadRequestException('Explain the reason when Other is selected.');
    }
    if (dto.action === EstimateRevisionItemAction.REPLACE && !dto.piece) {
      throw new BadRequestException(
        'Configure the complete replacement Piece before saving.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRemeasurementCanBeRecorded(jobId, tx);
      const measurement = await tx.installationMeasurement.findFirst({
        where: { id: measurementId, jobId, isManual: false },
        include: { piece: { include: revisionPieceInclude } },
      });
      if (!measurement?.piece) {
        throw new NotFoundException(
          'The selected Estimate Piece occurrence was not found.',
        );
      }

      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      const revision = await this.ensureDraftRevision(
        jobId,
        quote,
        user.id,
        tx,
      );

      if (dto.action === EstimateRevisionItemAction.REMOVE) {
        await tx.installationMeasurement.update({
          where: { id: measurementId },
          data: {
            status: InstallationMeasurementStatus.COMPLETED,
            measuredById: user.id,
            measuredAt: new Date(),
          },
        });
        await tx.estimateRevisionItem.upsert({
          where: {
            revisionId_measurementId: {
              revisionId: revision.id,
              measurementId,
            },
          },
          create: {
            revisionId: revision.id,
            measurementId,
            originalPieceId: measurement.pieceId,
            sourceUnitIndex: measurement.unitIndex,
            action: EstimateRevisionItemAction.REMOVE,
            reason: dto.reason,
            reasonNote: dto.note?.trim() || null,
            originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
          },
          update: {
            originalPieceId: measurement.pieceId,
            sourceUnitIndex: measurement.unitIndex,
            action: EstimateRevisionItemAction.REMOVE,
            reason: dto.reason,
            reasonNote: dto.note?.trim() || null,
            originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
            proposedPieceInput: Prisma.JsonNull,
            calculatedSnapshot: Prisma.JsonNull,
          },
        });
      } else {
        const replacementInput: CreatePieceDto = {
          ...dto.piece!,
          mark: dto.piece!.mark.trim() || measurement.piece.mark,
          qty: 1,
        };
        const effectiveMarkup = await this.resolveEstimateOwnerMarkup(
          revision.estimateId,
          tx,
        );
        const calculated = await this.pieceCalculator.calculatePieceMetrics(
          replacementInput,
          effectiveMarkup,
          tx,
          this.pieceCalculator.createCalculationCache(),
        );
        const pricing = await this.calculatedRevisionSnapshot(calculated, tx);
        const product = await tx.product.findUnique({
          where: { id: calculated.idProd },
          select: { kind: true },
        });

        await tx.installationMeasurement.update({
          where: { id: measurementId },
          data: {
            widthIn:
              product?.kind === ProductKind.LINEAR_MATERIAL
                ? null
                : calculated.width,
            heightIn: calculated.height,
            heightLeftIn: calculated.heightLeft,
            heightRightIn: calculated.heightRight,
            legHeightIn: calculated.legHeight,
            sashHeightIn: calculated.sashHeight,
            windowHeightIn: calculated.windowHeight,
            doorWidthIn: calculated.doorWidth,
            doorHeightIn: calculated.doorHeight,
            leftSideliteWidthIn: calculated.leftSideliteWidth,
            rightSideliteWidthIn: calculated.rightSideliteWidth,
            leftPanels: calculated.leftPanels,
            rightPanels: calculated.rightPanels,
            panelCount: calculated.panelCount,
            horizontalHeights: Array.isArray(calculated.horizontalHeights)
              ? this.jsonValue(calculated.horizontalHeights)
              : Prisma.JsonNull,
            lengthIn:
              product?.kind === ProductKind.LINEAR_MATERIAL
                ? calculated.width
                : null,
            status: InstallationMeasurementStatus.COMPLETED,
            measuredById: user.id,
            measuredAt: new Date(),
          },
        });
        await tx.estimateRevisionItem.upsert({
          where: {
            revisionId_measurementId: {
              revisionId: revision.id,
              measurementId,
            },
          },
          create: {
            revisionId: revision.id,
            measurementId,
            originalPieceId: measurement.pieceId,
            sourceUnitIndex: measurement.unitIndex,
            action: EstimateRevisionItemAction.REPLACE,
            reason: dto.reason,
            reasonNote: dto.note?.trim() || null,
            originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
            proposedPieceInput: this.jsonValue(replacementInput),
            calculatedSnapshot: this.jsonValue(pricing),
          },
          update: {
            originalPieceId: measurement.pieceId,
            sourceUnitIndex: measurement.unitIndex,
            action: EstimateRevisionItemAction.REPLACE,
            reason: dto.reason,
            reasonNote: dto.note?.trim() || null,
            originalSnapshot: this.originalRevisionSnapshot(measurement.piece),
            proposedPieceInput: this.jsonValue(replacementInput),
            calculatedSnapshot: this.jsonValue(pricing),
          },
        });
      }

      await this.recomputeRevisionTotals(revision.id, tx);
      await this.markQuoteForRecalculation(quote.id, tx);
      await this.updateRemeasurementProgress(jobId, tx);
    });
    return this.findJob(jobId, user);
  }

  async addLine(jobId: number, dto: AddInstallationLineDto, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (!isPrivileged(user) && job.status !== InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
      throw new BadRequestException('Requested services can only be changed before the installation deposit is paid.');
    }
    const origin = isPrivileged(user)
      ? dto.origin === InstallationLineOrigin.USER_SELECTED
        ? InstallationLineOrigin.USER_SELECTED
        : InstallationLineOrigin.FIELD_ADDED
      : InstallationLineOrigin.USER_SELECTED;

    await this.prisma.$transaction(async (tx) => {
      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      await this.addLineInTransaction(quote.id, dto, origin, tx);
      if (job.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
        await this.recalculateQuoteTotals(quote.id, tx);
      } else {
        await this.markQuoteForRecalculation(quote.id, tx);
      }
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status: preserveRemeasurementStage(job.status),
        },
      });
    });
    return this.findJob(jobId, user);
  }

  async removeLine(jobId: number, lineId: number, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (!isPrivileged(user) && job.status !== InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
      throw new BadRequestException('Requested services can only be changed before the installation deposit is paid.');
    }
    await this.prisma.$transaction(async (tx) => {
      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      const line = await tx.installationQuoteLine.findFirst({
        where: { id: lineId, quoteId: quote.id },
      });
      if (!line) throw new NotFoundException('Installation quote line not found.');
      if (line.origin === InstallationLineOrigin.AUTO) {
        throw new BadRequestException('Automatic lines are controlled by system-configuration mappings.');
      }
      if (!isPrivileged(user) && line.origin !== InstallationLineOrigin.USER_SELECTED) {
        throw new BadRequestException('This field-added line can only be removed by company staff.');
      }
      await tx.installationQuoteLine.delete({ where: { id: lineId } });
      if (job.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
        await this.recalculateQuoteTotals(quote.id, tx);
      } else {
        await this.markQuoteForRecalculation(quote.id, tx);
      }
    });
    return this.findJob(jobId, user);
  }

  async rebuildQuote(jobId: number, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (!isPrivileged(user)) throw new BadRequestException('Only company staff can recalculate a quote.');
    await this.prisma.$transaction(async (tx) => {
      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      await this.rebuildAutomaticLines(jobId, quote.id, tx);
      await this.rebuildManualLines(quote.id, tx);
      await this.recalculateQuoteTotals(quote.id, tx);
      await tx.installationQuote.update({
        where: { id: quote.id },
        data: { needsRecalculation: false },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status:
            job.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING ? InstallationJobStatus.DEPOSIT_PAYMENT_PENDING : InstallationJobStatus.QUOTE_DRAFT,
        },
      });
    });
    return this.findJob(jobId, user);
  }

  async submitQuote(jobId: number, dto: SubmitInstallationQuoteDto, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (!isPrivileged(user)) throw new BadRequestException('Only company staff can submit a quote.');

    if (new Decimal(job.depositAmountSnapshot.toString()).gt(0)) {
      const depositPaid = job.payments.some((payment) => payment.type === PaymentType.INSTALLATION_DEPOSIT && payment.status === PaymentStatus.PAID);
      const remeasurementCompleted = job.appointments.some(
        (appointment) => appointment.type === InstallationAppointmentType.REMEASUREMENT && appointment.status === InstallationAppointmentStatus.COMPLETED,
      );
      if (!depositPaid || !remeasurementCompleted) {
        throw new BadRequestException('Deposit payment and completed remeasurement are required before submitting the final quote.');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const pendingMeasurements = await tx.installationMeasurement.count({
        where: { jobId, status: InstallationMeasurementStatus.PENDING },
      });
      if (pendingMeasurements > 0) {
        throw new BadRequestException(`${pendingMeasurements} opening(s) still require field measurement.`);
      }

      const quote = await this.ensureDraftQuote(jobId, user.id, tx);
      if (quote.needsRecalculation) {
        throw new BadRequestException(
          'Recalculate the installation quote before submitting it.',
        );
      }
      if (!job.estimate.order) {
        const linkedMeasurements = await tx.installationMeasurement.findMany({
          where: { jobId, isManual: false, pieceId: { not: null } },
          select: { id: true },
        });
        const revision = await this.ensureDraftRevision(
          jobId,
          quote,
          user.id,
          tx,
        );
        const existingItems = await tx.estimateRevisionItem.findMany({
          where: { revisionId: revision.id },
          select: { measurementId: true },
        });
        const existingMeasurementIds = new Set(
          existingItems.map((item) => item.measurementId),
        );
        for (const measurement of linkedMeasurements) {
          if (!existingMeasurementIds.has(measurement.id)) {
            await this.upsertMeasuredPieceRevision(
              jobId,
              measurement.id,
              quote,
              user.id,
              tx,
            );
          }
        }
        const completedRevision = await tx.estimateRevision.findUnique({
          where: { id: revision.id },
          include: { items: true },
        });
        if (
          !completedRevision ||
          completedRevision.items.length !== linkedMeasurements.length
        ) {
          throw new BadRequestException(
            'Every Estimate Piece occurrence must have a material revision result.',
          );
        }
        const revisedTotals = completedRevision.revisedTotals as {
          units?: number;
        };
        if (Number(revisedTotals.units ?? 0) < 1) {
          throw new BadRequestException(
            'The revised Estimate must contain at least one Piece.',
          );
        }
        await tx.estimateRevision.update({
          where: { id: revision.id },
          data: {
            status: EstimateRevisionStatus.PENDING_ADMIN_APPROVAL,
            submittedAt: new Date(),
          },
        });
      }
      const lineCount = await tx.installationQuoteLine.count({
        where: { quoteId: quote.id },
      });
      if (lineCount === 0) throw new BadRequestException('The installation quote has no services.');

      const submittedQuote = await tx.installationQuote.updateMany({
        where: {
          id: quote.id,
          status: InstallationQuoteStatus.DRAFT,
          needsRecalculation: false,
        },
        data: {
          status: InstallationQuoteStatus.PENDING_ADMIN_APPROVAL,
          submittedAt: new Date(),
          notes: dto.notes?.trim() || quote.notes,
        },
      });
      if (submittedQuote.count !== 1) {
        throw new BadRequestException(
          'The installation quote changed. Recalculate it before submitting.',
        );
      }
      await tx.installationJob.update({
        where: { id: jobId },
        data: { status: InstallationJobStatus.ADMIN_APPROVAL_PENDING },
      });
    });
    return this.findJob(jobId, user);
  }

  async adminDecision(jobId: number, dto: InstallationApprovalDto, user: AuthUser) {
    if (user.role?.name !== 'admin') {
      throw new BadRequestException('Admin approval is required at this stage.');
    }
    await this.findJob(jobId, user);

    await this.prisma.$transaction(async (tx) => {
      const quote = await tx.installationQuote.findFirst({
        where: { jobId },
        orderBy: { version: 'desc' },
      });
      if (!quote || quote.status !== InstallationQuoteStatus.PENDING_ADMIN_APPROVAL) {
        throw new BadRequestException('This quote is not pending admin approval.');
      }

      await tx.installationQuoteApproval.create({
        data: {
          quoteId: quote.id,
          stage: InstallationApprovalStage.ADMIN,
          decision: dto.decision,
          comment: dto.comment?.trim() || null,
          actorId: user.id,
        },
      });

      const approved = dto.decision === InstallationApprovalDecision.APPROVED;
      await tx.installationQuote.update({
        where: { id: quote.id },
        data: {
          status: approved ? InstallationQuoteStatus.PENDING_CUSTOMER_APPROVAL : InstallationQuoteStatus.REJECTED,
        },
      });
      await tx.estimateRevision.updateMany({
        where: {
          quoteId: quote.id,
          status: EstimateRevisionStatus.PENDING_ADMIN_APPROVAL,
        },
        data: {
          status: approved
            ? EstimateRevisionStatus.PENDING_CUSTOMER_APPROVAL
            : EstimateRevisionStatus.REJECTED,
          rejectedAt: approved ? null : new Date(),
        },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status: approved ? InstallationJobStatus.CUSTOMER_APPROVAL_PENDING : InstallationJobStatus.QUOTE_DRAFT,
        },
      });
    });
    return this.findJob(jobId, user);
  }

  private revisionDecimal(value: unknown): Prisma.Decimal | null {
    return value == null || value === ''
      ? null
      : new Prisma.Decimal(String(value));
  }

  private revisionPieceData(
    input: Record<string, any>,
    pricing: RevisionPiecePricingSnapshot,
    qty: number,
    mark: string,
  ): Omit<Prisma.PieceUncheckedCreateInput, 'idEst'> {
    const price = new Decimal(pricing.price);
    const customerPrice = new Decimal(pricing.customerPrice);
    const quantity = new Decimal(qty);
    return {
      mark,
      idProd: Number(input.idProd),
      idBrand: Number(input.idBrand),
      idSyst: Number(input.idSyst),
      idConf: Number(input.idConf),
      idFC: Number(input.idFC),
      idCryst: input.idCryst == null ? null : Number(input.idCryst),
      idTint: input.idTint == null ? null : Number(input.idTint),
      idCoat: input.idCoat == null ? null : Number(input.idCoat),
      privacy: Boolean(input.privacy),
      screen: Boolean(input.screen),
      highBottom: Boolean(input.highBottom),
      highBottomPercent: this.revisionDecimal(pricing.highBottomPercent),
      idActiveOption:
        input.idActiveOption == null ? null : Number(input.idActiveOption),
      idPreparationOption:
        input.idPreparationOption == null
          ? null
          : Number(input.idPreparationOption),
      idSillOption:
        input.idSillOption == null ? null : Number(input.idSillOption),
      idReinforcementOption:
        input.idReinforcementOption == null
          ? null
          : Number(input.idReinforcementOption),
      width: this.revisionDecimal(input.width),
      height: this.revisionDecimal(input.height),
      heightLeft: this.revisionDecimal(input.heightLeft),
      heightRight: this.revisionDecimal(input.heightRight),
      legHeight: this.revisionDecimal(input.legHeight),
      sashHeight: this.revisionDecimal(input.sashHeight),
      windowHeight: this.revisionDecimal(input.windowHeight),
      doorWidth: this.revisionDecimal(input.doorWidth),
      doorHeight: this.revisionDecimal(input.doorHeight),
      leftSideliteWidth: this.revisionDecimal(input.leftSideliteWidth),
      rightSideliteWidth: this.revisionDecimal(input.rightSideliteWidth),
      leftPanels:
        input.leftPanels == null ? null : Math.trunc(Number(input.leftPanels)),
      rightPanels:
        input.rightPanels == null
          ? null
          : Math.trunc(Number(input.rightPanels)),
      panelCount:
        input.panelCount == null ? null : Math.trunc(Number(input.panelCount)),
      horizontalHeights: Array.isArray(input.horizontalHeights)
        ? this.jsonValue(input.horizontalHeights)
        : Prisma.JsonNull,
      qty,
      rate: new Prisma.Decimal(pricing.rate),
      price: new Prisma.Decimal(pricing.price),
      netProfit: new Prisma.Decimal(pricing.netProfit),
      markup: new Prisma.Decimal(pricing.markup),
      dealerMarkup: new Prisma.Decimal(pricing.dealerMarkupDecimal),
      subtotal: new Prisma.Decimal(price.mul(quantity).toFixed(2)),
      netProfitD: new Prisma.Decimal(
        customerPrice.minus(price).mul(quantity).toFixed(2),
      ),
      customerPrice: new Prisma.Decimal(pricing.customerPrice),
      customerSubtotal: new Prisma.Decimal(
        customerPrice.mul(quantity).toFixed(2),
      ),
      dpPosPsf: new Prisma.Decimal(pricing.dpPosPsf),
      dpNegPsf: new Prisma.Decimal(pricing.dpNegPsf),
    };
  }

  private async createRevisionPiece(
    estimateId: number,
    input: Record<string, any>,
    pricing: RevisionPiecePricingSnapshot,
    qty: number,
    mark: string,
    tx: PrismaTransactionClient,
  ) {
    const created = await tx.piece.create({
      data: {
        idEst: estimateId,
        ...this.revisionPieceData(input, pricing, qty, mark),
      },
      select: { id: true },
    });
    const muntin = input.muntin as CreatePieceDto['muntin'];
    const muntinCreate = this.muntinService.buildPieceMuntinCreateInput(muntin);
    if (muntin && muntinCreate) {
      await tx.pieceMuntin.create({
        data: {
          piece: { connect: { id: created.id } },
          pattern: { connect: { id: muntin.idPattern } },
          ...(muntin.idType
            ? { type: { connect: { id: muntin.idType } } }
            : {}),
          totalLites: muntinCreate.totalLites,
          ...(muntin.panels.length > 0
            ? {
                panels: {
                  create: muntin.panels.map((panel) => ({
                    panelIndex: panel.panelIndex,
                    panelCode: panel.panelCode ?? null,
                    panelLabel: panel.panelLabel,
                    horizontalLites: panel.horizontalLites,
                    verticalLites: panel.verticalLites,
                  })),
                },
              }
            : {}),
        },
      });
    }
    return tx.piece.findUniqueOrThrow({
      where: { id: created.id },
      include: revisionPieceInclude,
    });
  }

  private async applyEstimateRevision(
    revisionId: number,
    actorId: number,
    tx: PrismaTransactionClient,
  ) {
    const revision = await tx.estimateRevision.findUnique({
      where: { id: revisionId },
      include: {
        items: {
          orderBy: [
            { originalPieceId: 'asc' },
            { sourceUnitIndex: 'asc' },
          ],
        },
        estimate: {
          include: {
            order: true,
            pieces: { include: revisionPieceInclude },
          },
        },
      },
    });
    if (!revision) throw new NotFoundException('Estimate revision not found.');
    if (revision.status !== EstimateRevisionStatus.PENDING_CUSTOMER_APPROVAL) {
      throw new BadRequestException(
        'This material revision is not awaiting customer approval.',
      );
    }
    if (revision.estimate.order) {
      throw new BadRequestException(
        'Estimate material cannot be revised after the Order is created.',
      );
    }

    const originalPieceById = new Map(
      revision.estimate.pieces.map((piece) => [piece.id, piece]),
    );
    const itemsByPiece = new Map<number, typeof revision.items>();
    for (const item of revision.items) {
      if (item.originalPieceId == null) continue;
      const current = itemsByPiece.get(item.originalPieceId) ?? [];
      current.push(item);
      itemsByPiece.set(item.originalPieceId, current);
    }

    const measurementIds = revision.items.map((item) => item.measurementId);
    if (measurementIds.length > 0) {
      await tx.installationMeasurement.updateMany({
        where: { id: { in: measurementIds } },
        data: { pieceId: null },
      });
    }

    for (const [originalPieceId, items] of itemsByPiece) {
      const originalPiece = originalPieceById.get(originalPieceId);
      if (!originalPiece) {
        throw new BadRequestException(
          `Original Piece #${originalPieceId} no longer exists.`,
        );
      }
      if (items.length !== originalPiece.qty) {
        throw new BadRequestException(
          `Piece "${originalPiece.mark}" does not have one revision result per unit.`,
        );
      }

      const unchanged = items.every(
        (item) => item.action === EstimateRevisionItemAction.UNCHANGED,
      );
      if (unchanged) {
        for (const item of items) {
          await tx.installationMeasurement.update({
            where: { id: item.measurementId },
            data: {
              pieceId: originalPiece.id,
              unitIndex: item.sourceUnitIndex,
              sourceSnapshot: this.sourceSnapshot(originalPiece),
            },
          });
        }
        continue;
      }

      const groups = new Map<
        string,
        {
          input: Record<string, any>;
          pricing: RevisionPiecePricingSnapshot;
          items: typeof items;
        }
      >();
      for (const item of items) {
        if (item.action === EstimateRevisionItemAction.REMOVE) continue;
        const input = item.proposedPieceInput as Record<string, any> | null;
        const pricing = item.calculatedSnapshot as
          | (RevisionPiecePricingSnapshot & Prisma.JsonObject)
          | null;
        if (!input || !pricing) {
          throw new BadRequestException(
            `The proposal for "${originalPiece.mark}" is incomplete.`,
          );
        }
        const fingerprint = createEstimateRevisionPieceFingerprint(
          input,
          pricing,
        );
        const group = groups.get(fingerprint) ?? {
          input,
          pricing,
          items: [],
        };
        group.items.push(item);
        groups.set(fingerprint, group);
      }

      const createdGroups = [...groups.values()].sort(
        (left, right) =>
          left.items[0].sourceUnitIndex - right.items[0].sourceUnitIndex,
      );
      for (const group of createdGroups) {
        const requestedMark = String(group.input.mark ?? '').trim();
        const mark =
          createdGroups.length === 1 && group.items.length === originalPiece.qty
            ? requestedMark || originalPiece.mark
            : `${requestedMark || originalPiece.mark}-${group.items[0].sourceUnitIndex}`;
        const createdPiece = await this.createRevisionPiece(
          revision.estimateId,
          group.input,
          group.pricing,
          group.items.length,
          mark,
          tx,
        );
        for (const [index, item] of group.items.entries()) {
          await tx.installationMeasurement.update({
            where: { id: item.measurementId },
            data: {
              pieceId: createdPiece.id,
              unitIndex: index + 1,
              label:
                group.items.length > 1
                  ? `${mark} (${index + 1}/${group.items.length})`
                  : mark,
              sourceSnapshot: this.sourceSnapshot(createdPiece),
            },
          });
        }
      }

      await tx.piece.delete({ where: { id: originalPieceId } });
    }

    const persistedPieces = await tx.piece.findMany({
      where: { idEst: revision.estimateId },
      select: {
        qty: true,
        rate: true,
        price: true,
        customerPrice: true,
        dealerMarkup: true,
      },
    });
    if (persistedPieces.length === 0) {
      throw new BadRequestException(
        'The revised Estimate must contain at least one Piece.',
      );
    }
    const totals =
      this.pieceCalculator.calculateEstimateTotalsFromPersistedPieces(
        persistedPieces,
        new Decimal(revision.estimate.taxRate.toString()),
        new Decimal(revision.estimate.customerTaxRate.toString()),
      );
    await tx.estimate.update({
      where: { id: revision.estimateId },
      data: {
        ...totals,
        units: persistedPieces.reduce((sum, piece) => sum + piece.qty, 0),
      },
    });
    await tx.estimateRevision.updateMany({
      where: {
        installationJobId: revision.installationJobId,
        id: { not: revision.id },
        status: EstimateRevisionStatus.APPROVED,
      },
      data: { status: EstimateRevisionStatus.SUPERSEDED },
    });
    await tx.estimateRevision.update({
      where: { id: revision.id },
      data: {
        status: EstimateRevisionStatus.APPROVED,
        approvedAt: new Date(),
        appliedAt: new Date(),
      },
    });
    await tx.eventLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'EstimateRevision',
        entityId: revision.id,
        userId: actorId,
        message: `Estimate revision v${revision.version} approved and applied to Estimate #${revision.estimate.number}.`,
      },
    });
  }

  async customerDecision(jobId: number, dto: InstallationApprovalDto, user: AuthUser) {
    const job = await this.findJob(jobId, user);
    if (job.estimate.idUser !== user.id) {
      throw new BadRequestException('Only the estimate owner can approve this quote.');
    }

    await this.prisma.$transaction(async (tx) => {
      const quote = await tx.installationQuote.findFirst({
        where: { jobId },
        orderBy: { version: 'desc' },
      });
      if (!quote || quote.status !== InstallationQuoteStatus.PENDING_CUSTOMER_APPROVAL) {
        throw new BadRequestException('This quote is not pending customer approval.');
      }

      await tx.installationQuoteApproval.create({
        data: {
          quoteId: quote.id,
          stage: InstallationApprovalStage.CUSTOMER,
          decision: dto.decision,
          comment: dto.comment?.trim() || null,
          actorId: user.id,
        },
      });

      const approved = dto.decision === InstallationApprovalDecision.APPROVED;
      const materialRevision = await tx.estimateRevision.findUnique({
        where: { quoteId: quote.id },
        select: { id: true, status: true },
      });
      if (materialRevision) {
        if (
          materialRevision.status !==
          EstimateRevisionStatus.PENDING_CUSTOMER_APPROVAL
        ) {
          throw new BadRequestException(
            'The material revision is not awaiting customer approval.',
          );
        }
        if (approved) {
          await this.applyEstimateRevision(materialRevision.id, user.id, tx);
        } else {
          await tx.estimateRevision.update({
            where: { id: materialRevision.id },
            data: {
              status: EstimateRevisionStatus.REJECTED,
              rejectedAt: new Date(),
            },
          });
        }
      }
      if (approved) {
        await tx.installationQuote.updateMany({
          where: {
            jobId,
            id: { not: quote.id },
            status: InstallationQuoteStatus.APPROVED,
          },
          data: { status: InstallationQuoteStatus.SUPERSEDED },
        });
      }

      await tx.installationQuote.update({
        where: { id: quote.id },
        data: {
          status: approved ? InstallationQuoteStatus.APPROVED : InstallationQuoteStatus.REJECTED,
          approvedAt: approved ? new Date() : null,
        },
      });

      const permit = await tx.installationPermit.findUnique({
        where: { jobId },
      });
      const [estimate, paidInstallation, paidInstallationBalance, progress] = await Promise.all([
        tx.estimate.findFirst({
          where: { installationJob: { id: jobId } },
          include: { order: { include: { status: true } } },
        }),
        tx.payment.aggregate({
          where: {
            installationJobId: jobId,
            type: {
              in: [PaymentType.INSTALLATION_DEPOSIT, PaymentType.INSTALLATION],
            },
            status: PaymentStatus.PAID,
          },
          _sum: { baseAmount: true },
        }),
        tx.payment.aggregate({
          where: {
            installationJobId: jobId,
            type: PaymentType.INSTALLATION,
            status: PaymentStatus.PAID,
          },
          _sum: { baseAmount: true },
        }),
        tx.installationJob.findUnique({
          where: { id: jobId },
          select: {
            status: true,
            completedAt: true,
            appointments: {
              where: {
                type: InstallationAppointmentType.INSTALLATION,
                status: {
                  in: [InstallationAppointmentStatus.ACCEPTED, InstallationAppointmentStatus.COMPLETED],
                },
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        }),
      ]);
      const paidInstallationTotal = new Decimal(paidInstallation._sum.baseAmount?.toString() ?? 0);
      const installationBalance = calculateInstallationBalance(quote.total.toString(), [paidInstallationTotal]);
      const paidInstallationBalanceTotal = new Decimal(paidInstallationBalance._sum.baseAmount?.toString() ?? 0);

      let nextStatus: InstallationJobStatus = InstallationJobStatus.QUOTE_DRAFT;
      if (approved) {
        if (!estimate?.order) {
          nextStatus = resolveApprovedPreOrderStage(permit);
        } else if (['Ready to pick up', 'Delivered'].includes(estimate.order.status.name) || paidInstallationBalanceTotal.gt(0)) {
          nextStatus = installationBalance.gt(0)
            ? InstallationJobStatus.INSTALLATION_PAYMENT_PENDING
            : progress?.status === InstallationJobStatus.IN_PROGRESS
              ? InstallationJobStatus.IN_PROGRESS
              : progress?.completedAt || progress?.appointments[0]?.status === InstallationAppointmentStatus.COMPLETED
                ? InstallationJobStatus.COMPLETED
                : progress?.appointments[0]?.status === InstallationAppointmentStatus.ACCEPTED
                  ? InstallationJobStatus.SCHEDULED
                  : InstallationJobStatus.INSTALLATION_PAID;
        } else {
          nextStatus = InstallationJobStatus.MATERIAL_PAID;
        }
      }

      await tx.installationJob.update({
        where: { id: jobId },
        data: { status: nextStatus },
      });
    });
    return this.findJob(jobId, user);
  }

  async updatePermit(jobId: number, dto: UpdateInstallationPermitDto, user: AuthUser) {
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can update permit processing.');
    }
    await this.findJob(jobId, user);

    await this.prisma.$transaction(async (tx) => {
      const permit = await tx.installationPermit.findUnique({
        where: { jobId },
      });
      if (!permit) throw new BadRequestException('This installation did not request a permit.');
      const materialPayment = await tx.payment.findFirst({
        where: {
          installationJobId: jobId,
          type: PaymentType.MATERIAL,
          OR: [{ status: PaymentStatus.PAID }, { stripeSessionId: { not: null } }],
        },
        select: { id: true },
      });
      if (materialPayment) {
        throw new BadRequestException('Permit status and City Fee are frozen after material checkout starts.');
      }
      if (dto.status === InstallationPermitStatus.PAYMENT_PENDING || dto.status === InstallationPermitStatus.PAID) {
        throw new BadRequestException('Permit payment status is controlled by checkout.');
      }
      if (permit.status === InstallationPermitStatus.PAYMENT_PENDING) {
        throw new BadRequestException('The Permit Fee must be paid before permit processing begins.');
      }

      const allowedPermitTransitions: Record<InstallationPermitStatus, InstallationPermitStatus[]> = {
        [InstallationPermitStatus.PAYMENT_PENDING]: [],
        [InstallationPermitStatus.PAID]: [InstallationPermitStatus.PAID, InstallationPermitStatus.SUBMITTED],
        [InstallationPermitStatus.SUBMITTED]: [
          InstallationPermitStatus.SUBMITTED,
          InstallationPermitStatus.CHANGES_REQUIRED,
          InstallationPermitStatus.APPROVED,
          InstallationPermitStatus.REJECTED,
        ],
        [InstallationPermitStatus.CHANGES_REQUIRED]: [
          InstallationPermitStatus.CHANGES_REQUIRED,
          InstallationPermitStatus.SUBMITTED,
          InstallationPermitStatus.REJECTED,
        ],
        [InstallationPermitStatus.APPROVED]: [InstallationPermitStatus.APPROVED],
        [InstallationPermitStatus.REJECTED]: [InstallationPermitStatus.REJECTED, InstallationPermitStatus.SUBMITTED],
      };
      if (!allowedPermitTransitions[permit.status].includes(dto.status)) {
        throw new BadRequestException(`Permit cannot move from ${permit.status} to ${dto.status}.`);
      }
      if (dto.status === InstallationPermitStatus.APPROVED && dto.cityFee === undefined && permit.cityFee == null) {
        throw new BadRequestException('City Fee is required when the permit is approved.');
      }

      const updated = await tx.installationPermit.update({
        where: { jobId },
        data: {
          status: dto.status,
          ...(dto.cityFee !== undefined ? { cityFee: dto.cityFee } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.status === InstallationPermitStatus.SUBMITTED ? { submittedAt: new Date() } : {}),
          ...(dto.status === InstallationPermitStatus.APPROVED ? { approvedAt: new Date() } : {}),
        },
      });

      const quote = await tx.installationQuote.findFirst({
        where: { jobId, status: InstallationQuoteStatus.APPROVED },
        orderBy: { version: 'desc' },
      });
      const nextJobStatus =
        updated.status === InstallationPermitStatus.APPROVED && updated.cityFee != null && quote
          ? InstallationJobStatus.MATERIAL_PAYMENT_PENDING
          : InstallationJobStatus.PERMIT_PROCESSING;
      await tx.installationJob.update({
        where: { id: jobId },
        data: { status: nextJobStatus },
      });
    });
    return this.findJob(jobId, user);
  }

  async proposeAppointment(jobId: number, dto: ProposeInstallationAppointmentDto, user: AuthUser) {
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can propose appointment dates.');
    }
    const job = await this.findJob(jobId, user);
    const installationStatuses: InstallationJobStatus[] = [
      InstallationJobStatus.INSTALLATION_PAID,
      InstallationJobStatus.SCHEDULING,
      InstallationJobStatus.SCHEDULED,
    ];
    const measurementStatuses: InstallationJobStatus[] = [InstallationJobStatus.MEASUREMENT_SCHEDULING, InstallationJobStatus.MEASUREMENT_SCHEDULED];
    if (dto.type === InstallationAppointmentType.REMEASUREMENT && !measurementStatuses.includes(job.status)) {
      throw new BadRequestException('The installation deposit must be paid before scheduling remeasurement.');
    }
    if (dto.type === InstallationAppointmentType.INSTALLATION && !installationStatuses.includes(job.status)) {
      throw new BadRequestException('Installation must be paid before scheduling its appointment.');
    }

    const startsAt = new Date(dto.startsAt);
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (endsAt && endsAt <= startsAt) {
      throw new BadRequestException('Appointment end must be after its start.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.installationAppointment.updateMany({
        where: {
          jobId,
          type: dto.type,
          status: {
            in: [InstallationAppointmentStatus.PROPOSED, InstallationAppointmentStatus.ACCEPTED, InstallationAppointmentStatus.RESCHEDULE_REQUESTED],
          },
        },
        data: { status: InstallationAppointmentStatus.SUPERSEDED },
      });
      await tx.installationAppointment.create({
        data: {
          jobId,
          type: dto.type,
          startsAt,
          endsAt,
          note: dto.note?.trim() || null,
          proposedById: user.id,
        },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status: dto.type === InstallationAppointmentType.REMEASUREMENT ? InstallationJobStatus.MEASUREMENT_SCHEDULING : InstallationJobStatus.SCHEDULING,
        },
      });
    });
    return this.findJob(jobId, user);
  }

  async respondAppointment(appointmentId: number, dto: RespondInstallationAppointmentDto, user: AuthUser) {
    const appointment = await this.prisma.installationAppointment.findUnique({
      where: { id: appointmentId },
      include: { job: { include: { estimate: true } } },
    });
    if (!appointment || appointment.job.estimate.idUser !== user.id) {
      throw new NotFoundException('Installation appointment not found.');
    }
    if (appointment.status !== InstallationAppointmentStatus.PROPOSED) {
      throw new BadRequestException('This appointment proposal is no longer awaiting a response.');
    }

    await this.prisma.$transaction(async (tx) => {
      const accepted = dto.response === InstallationAppointmentResponse.ACCEPT;
      await tx.installationAppointment.update({
        where: { id: appointmentId },
        data: {
          status: accepted ? InstallationAppointmentStatus.ACCEPTED : InstallationAppointmentStatus.RESCHEDULE_REQUESTED,
          responseNote: dto.note?.trim() || null,
          respondedById: user.id,
          respondedAt: new Date(),
        },
      });
      await tx.installationJob.update({
        where: { id: appointment.jobId },
        data: {
          status: accepted
            ? appointment.type === InstallationAppointmentType.REMEASUREMENT
              ? InstallationJobStatus.MEASUREMENT_SCHEDULED
              : InstallationJobStatus.SCHEDULED
            : appointment.type === InstallationAppointmentType.REMEASUREMENT
              ? InstallationJobStatus.MEASUREMENT_SCHEDULING
              : InstallationJobStatus.SCHEDULING,
        },
      });
    });
    return this.findJob(appointment.jobId, user);
  }

  async startJob(jobId: number, user: AuthUser) {
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can start an installation.');
    }
    const job = await this.findJob(jobId, user);
    if (job.status !== InstallationJobStatus.SCHEDULED) {
      throw new BadRequestException('Installation requires an accepted schedule before it can start.');
    }
    if (!job.estimate.order || job.estimate.order.status.name !== 'Delivered') {
      throw new BadRequestException('The order must be Delivered before installation can start.');
    }

    const approvedQuote = job.quotes.find((quote) => quote.status === InstallationQuoteStatus.APPROVED);
    if (!approvedQuote) {
      throw new BadRequestException('No approved installation quote exists.');
    }
    const paidInstallation = job.payments
      .filter(
        (payment) => (payment.type === PaymentType.INSTALLATION_DEPOSIT || payment.type === PaymentType.INSTALLATION) && payment.status === PaymentStatus.PAID,
      )
      .reduce((sum, payment) => sum.add(payment.baseAmount.toString()), new Decimal(0));
    if (paidInstallation.lt(approvedQuote.total.toString())) {
      throw new BadRequestException('Installation must be fully paid before work can start.');
    }

    await this.prisma.$transaction(async (tx) => {
      const inProgress = await tx.orderStatus.findUnique({
        where: { name: 'Installation in progress' },
      });
      if (!inProgress) {
        throw new Error('Order status "Installation in progress" is not seeded.');
      }
      await tx.order.update({
        where: { id: job.estimate.order!.id },
        data: { statusId: inProgress.id, updateStatus: new Date() },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: { status: InstallationJobStatus.IN_PROGRESS },
      });
      await tx.eventLog.create({
        data: {
          action: 'START',
          entityType: 'InstallationJob',
          entityId: jobId,
          userId: user.id,
          message: `Installation started for Order #${job.estimate.order!.number}.`,
        },
      });
    });
    return this.findJob(jobId, user);
  }

  async completeJob(jobId: number, user: AuthUser) {
    if (!isPrivileged(user)) {
      throw new BadRequestException('Only company staff can complete an installation.');
    }
    const job = await this.findJob(jobId, user);
    if (job.status !== InstallationJobStatus.IN_PROGRESS || job.estimate.order?.status.name !== 'Installation in progress') {
      throw new BadRequestException('Only an installation in progress can be marked Installed.');
    }
    await this.prisma.$transaction(async (tx) => {
      const installed = await tx.orderStatus.findUnique({
        where: { name: 'Installed' },
      });
      if (!installed) {
        throw new Error('Order status "Installed" is not seeded.');
      }
      await tx.installationAppointment.updateMany({
        where: {
          jobId,
          type: InstallationAppointmentType.INSTALLATION,
          status: InstallationAppointmentStatus.ACCEPTED,
        },
        data: { status: InstallationAppointmentStatus.COMPLETED },
      });
      await tx.installationJob.update({
        where: { id: jobId },
        data: {
          status: InstallationJobStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
      await tx.order.update({
        where: { id: job.estimate.order!.id },
        data: { statusId: installed.id, updateStatus: new Date() },
      });
      await tx.eventLog.create({
        data: {
          action: 'COMPLETE',
          entityType: 'InstallationJob',
          entityId: jobId,
          userId: user.id,
          message: `Installation completed for Order #${job.estimate.order!.number}.`,
        },
      });
    });
    return this.findJob(jobId, user);
  }

  async refreshAfterEstimateChange(estimateId: number, actor: AuthUser): Promise<void> {
    const existingJob = await this.prisma.installationJob.findUnique({
      where: { estimateId },
      select: { id: true, status: true },
    });
    if (!existingJob || existingJob.status === InstallationJobStatus.CANCELED) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          pieces: {
            orderBy: { id: 'asc' },
            include: revisionPieceInclude,
          },
        },
      });
      if (!estimate) return;

      const measurements = await tx.installationMeasurement.findMany({
        where: { jobId: existingJob.id, pieceId: { not: null } },
        orderBy: { unitIndex: 'asc' },
      });

      const currentPieceIds = new Set(estimate.pieces.map((piece) => piece.id));
      await tx.installationMeasurement.deleteMany({
        where: {
          jobId: existingJob.id,
          pieceId: { not: null, notIn: [...currentPieceIds] },
        },
      });

      for (const piece of estimate.pieces) {
        const pieceMeasurements = measurements.filter((measurement) => measurement.pieceId === piece.id);

        for (const extra of pieceMeasurements.filter((measurement) => measurement.unitIndex > piece.qty)) {
          await tx.installationMeasurement.delete({ where: { id: extra.id } });
        }

        for (let unitIndex = 1; unitIndex <= piece.qty; unitIndex += 1) {
          const current = pieceMeasurements.find((measurement) => measurement.unitIndex === unitIndex);
          if (!current) {
            await tx.installationMeasurement.create({
              data: {
                jobId: existingJob.id,
                ...this.measurementCreateFromPiece(piece, unitIndex),
              },
            });
          } else if (current.status === InstallationMeasurementStatus.PENDING) {
            await tx.installationMeasurement.update({
              where: { id: current.id },
              data: {
                label: piece.qty > 1 ? `${piece.mark} (${unitIndex}/${piece.qty})` : piece.mark,
                sourceSnapshot: this.sourceSnapshot(piece),
                widthIn: piece.width,
                heightIn: piece.height,
                heightLeftIn: piece.heightLeft,
                heightRightIn: piece.heightRight,
                legHeightIn: piece.legHeight,
                sashHeightIn: piece.sashHeight,
                windowHeightIn: piece.windowHeight,
                doorWidthIn: piece.doorWidth,
                doorHeightIn: piece.doorHeight,
                leftSideliteWidthIn: piece.leftSideliteWidth,
                rightSideliteWidthIn: piece.rightSideliteWidth,
                leftPanels: piece.leftPanels,
                rightPanels: piece.rightPanels,
                panelCount: piece.panelCount,
                horizontalHeights: Array.isArray(piece.horizontalHeights)
                  ? this.jsonValue(piece.horizontalHeights)
                  : Prisma.JsonNull,
                lengthIn:
                  piece.prod.kind === ProductKind.LINEAR_MATERIAL
                    ? piece.width
                    : null,
              },
            });
          }
        }
      }

      const quote = await this.ensureDraftQuote(existingJob.id, actor.id, tx);
      await this.rebuildAutomaticLines(existingJob.id, quote.id, tx);
      await this.recalculateQuoteTotals(quote.id, tx);
      const pendingMeasurements = await tx.installationMeasurement.count({
        where: {
          jobId: existingJob.id,
          status: InstallationMeasurementStatus.PENDING,
        },
      });
      const nextStatus =
        existingJob.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING
          ? InstallationJobStatus.DEPOSIT_PAYMENT_PENDING
          : existingJob.status === InstallationJobStatus.MEASUREMENT_SCHEDULING || existingJob.status === InstallationJobStatus.MEASUREMENT_SCHEDULED
            ? existingJob.status
            : pendingMeasurements > 0
              ? InstallationJobStatus.MEASUREMENT_PENDING
              : InstallationJobStatus.QUOTE_DRAFT;
      await tx.installationJob.update({
        where: { id: existingJob.id },
        data: { status: nextStatus },
      });
    });
  }

  async getPaymentContext(
    estimateId: number,
    type: PaymentType,
    sequence: number | undefined,
    installationDepositTermsAccepted: boolean | undefined,
    user: AuthUser,
    tx: PrismaTransactionClient,
  ) {
    const estimate = await tx.estimate.findUnique({
      where: { id: estimateId },
      include: {
        status: true,
        order: { include: { status: true } },
        installationJob: {
          include: {
            permit: true,
            quotes: { orderBy: { version: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!estimate || estimate.idUser !== user.id) {
      throw new NotFoundException(`Estimate #${estimateId} not found.`);
    }

    const job = estimate.installationJob?.status === InstallationJobStatus.CANCELED ? null : estimate.installationJob;
    let baseAmount: Decimal;
    let description: string;
    let paymentSequence = 1;
    let extraCharge: Prisma.OrderExtraChargeGetPayload<{}> | null = null;

    if (type === PaymentType.INSTALLATION_DEPOSIT) {
      if (!job || job.status !== InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
        throw new BadRequestException('The installation deposit is not available for payment.');
      }
      const quote = job.quotes[0];
      if (!quote || quote.status !== InstallationQuoteStatus.DRAFT) {
        throw new BadRequestException('A preliminary installation quote is required before deposit payment.');
      }
      if (installationDepositTermsAccepted !== true && !job.depositTermsAcceptedAt) {
        throw new BadRequestException('Accept the non-refundable installation deposit terms before payment.');
      }
      if (!job.depositTermsAcceptedAt) {
        await tx.installationJob.update({
          where: { id: job.id },
          data: { depositTermsAcceptedAt: new Date() },
        });
      }
      baseAmount = new Decimal(job.depositAmountSnapshot.toString());
      paymentSequence = 1;
      description = `Non-refundable installation deposit — Estimate #${estimate.number}`;
    } else if (type === PaymentType.PERMIT) {
      if (!job?.permit || job.permit.status !== InstallationPermitStatus.PAYMENT_PENDING) {
        throw new BadRequestException('Permit Fee is not available for payment.');
      }
      const quote = job.quotes[0];
      if (!quote || quote.status !== InstallationQuoteStatus.APPROVED || job.status !== InstallationJobStatus.PERMIT_PAYMENT_PENDING) {
        throw new BadRequestException('Remeasurement and customer approval must be completed before Permit payment.');
      }
      baseAmount = new Decimal(job.permit.permitFeeSnapshot.toString());
      description = `Permit Fee — Estimate #${estimate.number}`;
    } else if (type === PaymentType.MATERIAL) {
      if (estimate.order) throw new ConflictException('This estimate already has an order.');
      if (estimate.status.name !== 'Active') {
        throw new BadRequestException('Material payment requires an active estimate.');
      }

      let cityFee = new Decimal(0);
      if (job) {
        const quote = job.quotes[0];
        if (!quote || quote.status !== InstallationQuoteStatus.APPROVED) {
          throw new BadRequestException('The final installation quote must be approved before material payment.');
        }
        if (job.status !== InstallationJobStatus.MATERIAL_PAYMENT_PENDING) {
          throw new BadRequestException('Material payment is not the current installation step.');
        }
        if (job.permit) {
          if (job.permit.status !== InstallationPermitStatus.APPROVED || job.permit.cityFee == null) {
            throw new BadRequestException('The permit and City Fee must be approved before material payment.');
          }
          cityFee = new Decimal(job.permit.cityFee.toString());
        }
      }
      baseAmount = new Decimal(estimate.totalPayable.toString()).add(cityFee);
      description = job ? `Material${cityFee.gt(0) ? ' + City Fee' : ''} — Estimate #${estimate.number}` : `Estimate #${estimate.number}`;
    } else if (type === PaymentType.INSTALLATION) {
      if (!job || !estimate.order) {
        throw new BadRequestException('Material must be paid before installation payment.');
      }
      const quote = job.quotes[0];
      if (!quote || quote.status !== InstallationQuoteStatus.APPROVED) {
        throw new BadRequestException('No approved installation quote is available.');
      }
      const paidInstallation = await tx.payment.aggregate({
        where: {
          installationJobId: job.id,
          type: {
            in: [PaymentType.INSTALLATION_DEPOSIT, PaymentType.INSTALLATION],
          },
          status: PaymentStatus.PAID,
        },
        _sum: { baseAmount: true },
      });
      const paidBase = new Decimal(paidInstallation._sum.baseAmount?.toString() ?? 0);
      const paidBalance = await tx.payment.aggregate({
        where: {
          installationJobId: job.id,
          type: PaymentType.INSTALLATION,
          status: PaymentStatus.PAID,
        },
        _sum: { baseAmount: true },
      });
      const paidBalanceBase = new Decimal(paidBalance._sum.baseAmount?.toString() ?? 0);
      if (!['Ready to pick up', 'Delivered'].includes(estimate.order.status.name) && paidBalanceBase.eq(0)) {
        throw new BadRequestException('Installation payment becomes available when the order is ready to pick up.');
      }
      baseAmount = calculateInstallationBalance(quote.total.toString(), [paidBase]);
      paymentSequence = quote.version;
      description = paidBalanceBase.gt(0)
        ? `Installation change order — Estimate #${estimate.number}`
        : `Installation balance after deposit — Estimate #${estimate.number}`;
    } else {
      if (!job || !estimate.order) {
        throw new BadRequestException('Extra charges are paid from an existing installation order.');
      }
      if (!Number.isInteger(sequence) || Number(sequence) < 1) {
        throw new BadRequestException('Extra charge sequence is required.');
      }
      extraCharge = await tx.orderExtraCharge.findFirst({
        where: {
          orderId: estimate.order.id,
          sequence: Number(sequence),
        },
      });
      if (!extraCharge || extraCharge.status !== OrderExtraChargeStatus.PAYMENT_DUE) {
        throw new BadRequestException('This extra charge is not available for payment.');
      }

      const quote = job.quotes[0];
      if (!quote || quote.status !== InstallationQuoteStatus.APPROVED) {
        throw new BadRequestException('An approved installation quote is required.');
      }
      const paidInstallation = await tx.payment.aggregate({
        where: {
          installationJobId: job.id,
          type: {
            in: [PaymentType.INSTALLATION_DEPOSIT, PaymentType.INSTALLATION],
          },
          status: PaymentStatus.PAID,
        },
        _sum: { baseAmount: true },
      });
      const paidInstallationTotal = new Decimal(paidInstallation._sum.baseAmount?.toString() ?? 0);
      if (paidInstallationTotal.lt(quote.total.toString())) {
        throw new BadRequestException('Installation must be paid before extra charges.');
      }

      baseAmount = new Decimal(extraCharge.total.toString());
      paymentSequence = extraCharge.sequence;
      description = `Extra charge #${extraCharge.sequence} — Order #${estimate.order.number}`;
    }

    if (baseAmount.lte(0)) throw new BadRequestException('Payment amount must be greater than zero.');

    const surchargeParameter = await tx.globalParameter.findUnique({
      where: { key: GlobalParameterKey.CARD_SURCHARGE_PERCENT },
    });
    const surchargeFraction = new Decimal(surchargeParameter?.value.toString() ?? 0);
    if (surchargeFraction.lt(0) || surchargeFraction.gt(1)) {
      throw new BadRequestException('Card surcharge must be stored as a decimal fraction between 0 and 1.');
    }
    const surchargePercent = surchargeFraction.mul(100);
    const surchargeAmount = baseAmount.mul(surchargeFraction).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    return {
      estimate,
      job,
      extraCharge,
      type,
      description,
      baseAmount: baseAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      surchargePercent,
      surchargeAmount,
      totalAmount: baseAmount.add(surchargeAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      paymentSequence,
    };
  }

  private async beginRemeasurementAfterDeposit(tx: PrismaTransactionClient, jobId: number) {
    const preliminary = await tx.installationQuote.findFirst({
      where: { jobId },
      orderBy: { version: 'desc' },
      include: {
        lines: { select: quoteLineSnapshotSelect, orderBy: { id: 'asc' } },
      },
    });
    if (!preliminary || preliminary.status !== InstallationQuoteStatus.DRAFT) {
      throw new Error(`Installation Job #${jobId} has no preliminary draft quote for remeasurement.`);
    }

    await tx.installationQuote.update({
      where: { id: preliminary.id },
      data: { status: InstallationQuoteStatus.SUPERSEDED },
    });
    await tx.installationQuote.create({
      data: {
        jobId,
        version: preliminary.version + 1,
        status: InstallationQuoteStatus.DRAFT,
        approvalReason: InstallationQuoteReason.REMEASUREMENT,
        profileId: preliminary.profileId,
        profileNameSnapshot: preliminary.profileNameSnapshot,
        profileAdjustmentPercent: preliminary.profileAdjustmentPercent,
        profileMinimumSnapshot: preliminary.profileMinimumSnapshot,
        baseSubtotal: preliminary.baseSubtotal,
        adjustedSubtotal: preliminary.adjustedSubtotal,
        serviceMinimumAdjustment: preliminary.serviceMinimumAdjustment,
        serviceMinimumsSnapshot:
          preliminary.serviceMinimumsSnapshot === null ? Prisma.JsonNull : (preliminary.serviceMinimumsSnapshot as Prisma.InputJsonValue),
        minimumAdjustment: preliminary.minimumAdjustment,
        total: preliminary.total,
        notes: preliminary.notes,
        createdById: preliminary.createdById,
        lines: {
          create: preliminary.lines.map((line) => ({
            ...line,
            ruleSnapshot: line.ruleSnapshot === null ? Prisma.JsonNull : (line.ruleSnapshot as Prisma.InputJsonValue),
          })),
        },
      },
    });
    await tx.installationJob.update({
      where: { id: jobId },
      data: { status: InstallationJobStatus.MEASUREMENT_SCHEDULING },
    });
  }

  async markPaymentPaid(
    tx: PrismaTransactionClient,
    payment: {
      type: PaymentType;
      installationJobId: number | null;
      extraChargeId: number | null;
    },
  ): Promise<boolean> {
    if (payment.type === PaymentType.INSTALLATION_DEPOSIT) {
      if (!payment.installationJobId) {
        throw new Error('Paid installation deposit has no installation job.');
      }
      const job = await tx.installationJob.findUnique({
        where: { id: payment.installationJobId },
        select: { status: true },
      });
      if (!job) {
        throw new Error(
          `Installation Job #${payment.installationJobId} not found.`,
        );
      }
      if (job.status !== InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
        return false;
      }
      await this.beginRemeasurementAfterDeposit(tx, payment.installationJobId);
      return true;
    } else if (payment.type === PaymentType.PERMIT) {
      if (!payment.installationJobId) {
        throw new Error('Paid permit has no installation job.');
      }
      const job = await tx.installationJob.findUnique({
        where: { id: payment.installationJobId },
        include: { permit: true },
      });
      if (!job) {
        throw new Error(
          `Installation Job #${payment.installationJobId} not found.`,
        );
      }
      if (!job.permit) {
        throw new Error(
          `Installation Job #${payment.installationJobId} has no permit.`,
        );
      }

      let changed = false;
      let permit = job.permit;
      if (permit.status === InstallationPermitStatus.PAYMENT_PENDING) {
        permit = await tx.installationPermit.update({
          where: { jobId: payment.installationJobId },
          data: { status: InstallationPermitStatus.PAID, paidAt: new Date() },
        });
        changed = true;
      } else if (!permit.paidAt) {
        permit = await tx.installationPermit.update({
          where: { jobId: payment.installationJobId },
          data: { paidAt: new Date() },
        });
        changed = true;
      }

      if (job.status === InstallationJobStatus.PERMIT_PAYMENT_PENDING) {
        await tx.installationJob.update({
          where: { id: payment.installationJobId },
          data: { status: resolveApprovedPreOrderStage(permit) },
        });
        changed = true;
      }
      return changed;
    } else if (payment.type === PaymentType.MATERIAL) {
      if (!payment.installationJobId) return false;
      const job = await tx.installationJob.findUnique({
        where: { id: payment.installationJobId },
        select: { status: true },
      });
      if (!job) {
        throw new Error(
          `Installation Job #${payment.installationJobId} not found.`,
        );
      }
      if (job.status !== InstallationJobStatus.MATERIAL_PAYMENT_PENDING) {
        return false;
      }
      await tx.installationJob.update({
        where: { id: payment.installationJobId },
        data: { status: InstallationJobStatus.MATERIAL_PAID },
      });
      return true;
    } else if (payment.type === PaymentType.INSTALLATION) {
      if (!payment.installationJobId) {
        throw new Error('Paid installation balance has no installation job.');
      }
      const progress = await tx.installationJob.findUnique({
        where: { id: payment.installationJobId },
        select: {
          status: true,
          completedAt: true,
          appointments: {
            where: {
              type: InstallationAppointmentType.INSTALLATION,
              status: {
                in: [InstallationAppointmentStatus.ACCEPTED, InstallationAppointmentStatus.COMPLETED],
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      });
      if (!progress) {
        throw new Error(
          `Installation Job #${payment.installationJobId} not found.`,
        );
      }
      if (
        progress.status !==
        InstallationJobStatus.INSTALLATION_PAYMENT_PENDING
      ) {
        return false;
      }
      const restoredStatus =
        progress.completedAt ||
        progress.appointments[0]?.status ===
          InstallationAppointmentStatus.COMPLETED
          ? InstallationJobStatus.COMPLETED
          : progress.appointments[0]?.status ===
              InstallationAppointmentStatus.ACCEPTED
            ? InstallationJobStatus.SCHEDULED
            : InstallationJobStatus.INSTALLATION_PAID;
      await tx.installationJob.update({
        where: { id: payment.installationJobId },
        data: { status: restoredStatus },
      });
      return true;
    } else if (payment.type === PaymentType.EXTRA) {
      if (!payment.extraChargeId) {
        throw new Error('Paid extra charge has no extra charge record.');
      }
      const extraCharge = await tx.orderExtraCharge.findUnique({
        where: { id: payment.extraChargeId },
      });
      if (!extraCharge) {
        throw new Error(`Extra Charge #${payment.extraChargeId} not found.`);
      }
      if (extraCharge.status !== OrderExtraChargeStatus.PAYMENT_DUE) {
        if (
          extraCharge.status === OrderExtraChargeStatus.PAID &&
          !extraCharge.paidAt
        ) {
          await tx.orderExtraCharge.update({
            where: { id: payment.extraChargeId },
            data: { paidAt: new Date() },
          });
          return true;
        }
        return false;
      }
      await tx.orderExtraCharge.update({
        where: { id: payment.extraChargeId },
        data: {
          status: OrderExtraChargeStatus.PAID,
          paidAt: new Date(),
        },
      });
      return true;
    }

    return false;
  }

  async markOrderReady(tx: PrismaTransactionClient, estimateId: number) {
    const job = await tx.installationJob.findUnique({
      where: { estimateId },
      include: {
        quotes: {
          where: { status: InstallationQuoteStatus.APPROVED },
          orderBy: { version: 'desc' },
          take: 1,
        },
        payments: {
          where: {
            type: {
              in: [PaymentType.INSTALLATION_DEPOSIT, PaymentType.INSTALLATION],
            },
            status: PaymentStatus.PAID,
          },
        },
      },
    });
    if (job && job.status === InstallationJobStatus.MATERIAL_PAID) {
      const credit = job.payments.reduce((sum, payment) => sum.add(payment.baseAmount.toString()), new Decimal(0));
      const quote = job.quotes[0];
      await tx.installationJob.update({
        where: { id: job.id },
        data: {
          status: quote && credit.gte(quote.total.toString()) ? InstallationJobStatus.INSTALLATION_PAID : InstallationJobStatus.INSTALLATION_PAYMENT_PENDING,
        },
      });
    }
  }

  async assertEstimateEditAllowed(estimateId: number, user: AuthUser): Promise<void> {
    const job = await this.prisma.installationJob.findUnique({
      where: { estimateId },
      select: {
        status: true,
        payments: {
          where: { type: PaymentType.INSTALLATION_DEPOSIT },
          select: { status: true, stripeSessionId: true },
        },
      },
    });
    if (!job) return;
    const depositCheckoutStarted = job.payments.some((payment) => payment.status === PaymentStatus.PAID || Boolean(payment.stripeSessionId));
    if (canOwnerEditInstallationEstimate(job.status, depositCheckoutStarted)) {
      return;
    }
    throw new BadRequestException(
      'This estimate is locked after installation-deposit checkout begins. Material changes must use the measured Estimate revision workflow.',
    );
  }
}

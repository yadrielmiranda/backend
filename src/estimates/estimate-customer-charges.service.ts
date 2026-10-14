import { canAccessOwner } from '@/dealer-network/dealer-network';
import { withAgreementTransaction } from '@/contracts/agreement-content';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DealerMode,
  EstimateCustomerChargeOrigin,
  EstimateCustomerChargePricingMode,
  EstimateCustomerChargeSource,
  Prisma,
} from '@prisma/client';

import type { AuthUser } from '@/auth/types/auth-user.type';
import { PrismaService } from '@/prisma/prisma.service';
import {
  buildEstimateInstallationSummary,
  estimateInstallationSummarySelect,
  type EstimateInstallationReportSummary,
} from './reporting/estimate-installation-summary';
import {
  CreateDealerCustomerChargeDto,
  UpdateDealerCustomerChargeDto,
  UpsertSystemCustomerChargeDto,
} from './dto/estimate-customer-charge.dto';

import {
  buildEstimateCustomerChargeSummary, buildSystemCustomerChargeSources,
  customerChargeDealerMode, isInternalDealerEstimate, systemCustomerChargeKey,
  type CustomerChargeRecord, type EstimateClassification,
} from './estimate-customer-charges.summary';
export * from './estimate-customer-charges.summary';

function moneyString(value: number) { return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2); }

@Injectable()
export class EstimateCustomerChargesService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadEstimate(estimateId: number, db: Prisma.TransactionClient = this.prisma) {
    return db.estimate.findUnique({
      where: { id: estimateId },
      select: {
        id: true,
        number: true,
        idUser: true,
        dealerModeSnapshot: true,
        dealerNetworkSnapshot: true,
        status: { select: { name: true } },
        order: { select: { id: true } },
        payments: { select: { status: true, paidAt: true, refundReviewPending: true } },
        user: {
          select: {
            dealerMode: true,
            role: { select: { name: true } },
          },
        },
        installationJob: {
          select: estimateInstallationSummarySelect,
        },
        customerCharges: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });
  }

  private summaryFromEstimate(
    estimate: NonNullable<Awaited<ReturnType<typeof this.loadEstimate>>>,
  ) {
    return buildEstimateCustomerChargeSummary({
      estimate,
      installation: buildEstimateInstallationSummary(estimate.installationJob),
      charges: estimate.customerCharges,
    });
  }

  buildSummary(params: {
    estimate: EstimateClassification;
    installation: EstimateInstallationReportSummary | null | undefined;
    charges: CustomerChargeRecord[];
  }) {
    return buildEstimateCustomerChargeSummary(params);
  }

  async findForEstimate(estimateId: number, actor: AuthUser, db: Prisma.TransactionClient = this.prisma) {
    const estimate = await this.loadEstimate(estimateId, db);

    if (!estimate || !await canAccessOwner(db, estimate.idUser, actor)) {
      throw new NotFoundException(`Estimate with ID #${estimateId} not found.`);
    }

    return this.summaryFromEstimate(estimate);
  }

  private async assertDealerCanEdit(
    estimateId: number,
    actor: AuthUser,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const estimate = await this.loadEstimate(estimateId, db);

    const isAdmin = actor.role?.name === 'admin';
    if (!estimate || (!isAdmin && (actor.role?.name !== 'dealer' || estimate.idUser !== actor.id))) {
      throw new NotFoundException(`Estimate with ID #${estimateId} not found.`);
    }

    const dealerMode = customerChargeDealerMode(estimate);
    if (dealerMode === null) {
      throw new BadRequestException(
        'Customer service prices are only available on dealer estimates.',
      );
    }

    if (estimate.status?.name !== 'Active' || estimate.order) {
      throw new BadRequestException(
        `Estimate #${estimate.number} customer charges are locked.`,
      );
    }

    if (dealerMode === DealerMode.INTERNAL && estimate.payments.some(payment =>
      ['PENDING', 'PAID', 'REFUNDED'].includes(payment.status) || payment.paidAt != null || payment.refundReviewPending,
    )) {
      throw new BadRequestException(
        'Customer charges cannot change after payment or while checkout is pending. Cancel the unpaid checkout first.',
      );
    }

    if (estimate.dealerModeSnapshot !== dealerMode) {
      await db.estimate.update({
        where: { id: estimate.id },
        data: { dealerModeSnapshot: dealerMode },
      });
      estimate.dealerModeSnapshot = dealerMode;
    }

    return estimate;
  }

  async upsertSystemCharge(
    estimateId: number,
    dto: UpsertSystemCustomerChargeDto,
    actor: AuthUser,
  ) {
    return withAgreementTransaction(this.prisma, estimateId, async (db) => {
    const estimate = await this.assertDealerCanEdit(estimateId, actor, db);
    const internal = isInternalDealerEstimate(estimate);
    if (internal && (dto.usedInCustomerQuote === false ||
      ![EstimateCustomerChargePricingMode.PERCENTAGE, EstimateCustomerChargePricingMode.AMOUNT].includes(dto.pricingMode as 'PERCENTAGE' | 'AMOUNT') ||
      !Number.isFinite(dto.value) || dto.value < 0)) {
      throw new BadRequestException(
        'Internal dealer company charges must stay included and can only have a nonnegative percentage or amount added.',
      );
    }
    const sourceKey = systemCustomerChargeKey(dto.source, dto.sourceRefId);
    const source = buildSystemCustomerChargeSources(
      buildEstimateInstallationSummary(estimate.installationJob),
    ).find((candidate) => candidate.sourceKey === sourceKey);

    if (!source) {
      throw new BadRequestException(
        'That company charge is not available on the current estimate.',
      );
    }

    if (
      dto.usedInCustomerQuote !== false &&
      dto.pricingMode !== EstimateCustomerChargePricingMode.FINAL &&
      dto.pricingMode !== EstimateCustomerChargePricingMode.SAME &&
      source.systemAmount === null
    ) {
      throw new BadRequestException(
        internal ? 'Wait until the company price is available before adding a charge.'
          : 'Use a final customer price until the company price is available.',
      );
    }

    await db.estimateCustomerCharge.upsert({
      where: {
        estimateId_sourceKey: {
          estimateId,
          sourceKey,
        },
      },
      create: {
        estimateId,
        origin: EstimateCustomerChargeOrigin.SYSTEM,
        source: source.source,
        sourceKey,
        sourceRefId: source.sourceRefId,
        description: source.description,
        pricingMode: dto.pricingMode,
        pricingValue: new Prisma.Decimal(dto.value),
        usedInCustomerQuote: dto.usedInCustomerQuote ?? true,
        systemAmountSnapshot:
          source.systemAmount === null
            ? null
            : new Prisma.Decimal(moneyString(source.systemAmount)),
        sortOrder: source.sortOrder,
      },
      update: {
        source: source.source,
        sourceRefId: source.sourceRefId,
        description: source.description,
        pricingMode: dto.pricingMode,
        pricingValue: new Prisma.Decimal(dto.value),
        ...(internal || dto.usedInCustomerQuote !== undefined
          ? { usedInCustomerQuote: internal ? true : dto.usedInCustomerQuote }
          : {}),
        systemAmountSnapshot:
          source.systemAmount === null
            ? null
            : new Prisma.Decimal(moneyString(source.systemAmount)),
        sortOrder: source.sortOrder,
      },
    });

    return this.findForEstimate(estimateId, actor, db);
    });
  }

  async createDealerCharge(
    estimateId: number,
    dto: CreateDealerCustomerChargeDto,
    actor: AuthUser,
  ) {
    return withAgreementTransaction(this.prisma, estimateId, async (db) => {
    const estimate = await this.assertDealerCanEdit(estimateId, actor, db);
    const description = dto.description?.trim();
    if (!description) {
      throw new BadRequestException('Charge description is required.');
    }

    const lastCharge = await db.estimateCustomerCharge.findFirst({
      where: { estimateId },
      orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
      select: { sortOrder: true },
    });

    await db.estimateCustomerCharge.create({
      data: {
        estimateId,
        origin: EstimateCustomerChargeOrigin.DEALER,
        source: EstimateCustomerChargeSource.CUSTOM,
        sourceKey: null,
        sourceRefId: null,
        description,
        pricingMode: EstimateCustomerChargePricingMode.FINAL,
        pricingValue: new Prisma.Decimal(dto.amount),
        systemAmountSnapshot: null,
        sortOrder: Math.max(1000, (lastCharge?.sortOrder ?? 990) + 10),
      },
    });

    return this.findForEstimate(estimate.id, actor, db);
    });
  }

  async updateDealerCharge(
    estimateId: number,
    chargeId: number,
    dto: UpdateDealerCustomerChargeDto,
    actor: AuthUser,
  ) {
    return withAgreementTransaction(this.prisma, estimateId, async (db) => {
    await this.assertDealerCanEdit(estimateId, actor, db);
    const charge = await db.estimateCustomerCharge.findFirst({
      where: {
        id: chargeId,
        estimateId,
        origin: EstimateCustomerChargeOrigin.DEALER,
      },
    });

    if (!charge) {
      throw new NotFoundException(`Customer charge #${chargeId} not found.`);
    }

    const description = dto.description?.trim();
    if (dto.description !== undefined && !description) {
      throw new BadRequestException('Charge description is required.');
    }
    if (dto.description === undefined && dto.amount === undefined) {
      throw new BadRequestException('No customer charge changes provided.');
    }

    await db.estimateCustomerCharge.update({
      where: { id: charge.id },
      data: {
        ...(description !== undefined ? { description } : {}),
        ...(dto.amount !== undefined
          ? { pricingValue: new Prisma.Decimal(dto.amount) }
          : {}),
      },
    });

    return this.findForEstimate(estimateId, actor, db);
    });
  }

  async removeCharge(estimateId: number, chargeId: number, actor: AuthUser) {
    return withAgreementTransaction(this.prisma, estimateId, async (db) => {
    await this.assertDealerCanEdit(estimateId, actor, db);
    const charge = await db.estimateCustomerCharge.findFirst({
      where: { id: chargeId, estimateId },
      select: { id: true },
    });

    if (!charge) {
      throw new NotFoundException(`Customer charge #${chargeId} not found.`);
    }

    await db.estimateCustomerCharge.delete({
      where: { id: charge.id },
    });

    return this.findForEstimate(estimateId, actor, db);
    });
  }

}

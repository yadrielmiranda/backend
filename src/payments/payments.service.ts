import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DealerMode,
  InstallationJobStatus,
  InstallationPermitStatus,
  OrderExtraChargeStatus,
  PaymentMethod,
  PaymentPayerType,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { INSTALLATION_DEPOSIT_TERMS } from '@/installation/installation-workflow.service';
import {
  calculateMaterialFinancials,
  resolveImpactMarkupRate,
  resolveMaterialSaleSubtotal,
} from '@/orders/order-material-financials';
import { NotificationsService } from '@/notifications/notifications.service';

type PaymentWithEstimate = Prisma.PaymentGetPayload<{
  include: {
    estimate: {
      include: {
        order: true;
        status: true;
        user: { include: { role: true } };
      };
    };
  };
}>;

@Injectable()
export class PaymentsService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(PaymentsService.name);
  private reconciliationInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly installationWorkflow: InstallationWorkflowService,
    private readonly notifications: NotificationsService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set in .env');
    this.stripe = new Stripe(key);
  }

  private getFrontendUrl(): string {
    const frontendUrl =
      this.config.get<string>('PUBLIC_FRONTEND_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      'http://localhost:3000';
    return String(frontendUrl).replace(/\/+$/, '');
  }

  private getPayerSnapshot(estimate: {
    dealerModeSnapshot: DealerMode | null;
    customerFirstName: string | null;
    customerLastName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    user: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    };
  }) {
    const finalCustomer = estimate.dealerModeSnapshot === DealerMode.INTERNAL;
    const name = finalCustomer
      ? [estimate.customerFirstName, estimate.customerLastName]
          .filter(Boolean)
          .join(' ')
          .trim()
      : `${estimate.user.firstName} ${estimate.user.lastName}`.trim();

    return {
      payerType: finalCustomer
        ? PaymentPayerType.CUSTOMER
        : PaymentPayerType.ACCOUNT_OWNER,
      payerName: name || null,
      payerEmail: finalCustomer ? estimate.customerEmail : estimate.user.email,
      payerPhone: finalCustomer ? estimate.customerPhone : estimate.user.phone,
    };
  }

  private async ensureOrderForMaterialPayment(
    tx: Prisma.TransactionClient,
    payment: PaymentWithEstimate,
  ): Promise<boolean> {
    const estimate = payment.estimate;

    if (estimate.order) {
      if (estimate.order.paymentId !== payment.id) {
        throw new Error(
          `Order #${estimate.order.number} is linked to another payment.`,
        );
      }
      if (estimate.status.name === 'Ordered') return false;
      if (estimate.status.name !== 'Active') {
        throw new Error(
          `Estimate #${estimate.number} has an order but cannot be reconciled from status ${estimate.status.name}.`,
        );
      }

      const orderedStatus = await tx.estimateStatus.findUnique({
        where: { name: 'Ordered' },
      });
      if (!orderedStatus) {
        throw new Error('Estimate status "Ordered" not seeded.');
      }
      await tx.estimate.update({
        where: { id: estimate.id },
        data: { statusId: orderedStatus.id },
      });
      return true;
    }

    if (!['Active', 'Ordered'].includes(estimate.status.name)) {
      throw new Error(
        `Estimate #${estimate.number} cannot create its paid material order from status ${estimate.status.name}.`,
      );
    }

    const [pendingStatus, orderedStatus, lastOrder] = await Promise.all([
      tx.orderStatus.findUnique({ where: { name: 'Pending' } }),
      tx.estimateStatus.findUnique({ where: { name: 'Ordered' } }),
      tx.order.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }),
    ]);
    if (!pendingStatus) throw new Error('Order status "Pending" not seeded.');
    if (!orderedStatus)
      throw new Error('Estimate status "Ordered" not seeded.');

    const saleSubtotal = resolveMaterialSaleSubtotal({
      dealerMode: estimate.dealerModeSnapshot,
      priceT: estimate.priceT.toString(),
      customerPriceT: estimate.customerPriceT.toString(),
    });
    const impactMarkupRate = resolveImpactMarkupRate({
      dealerMode: estimate.dealerModeSnapshot,
      dealerAffiliation: estimate.dealerAffiliationSnapshot,
      ownerMarkupSnapshot: estimate.ownerMarkupSnapshot.toString(),
      priceT: estimate.priceT.toString(),
      customerPriceT: estimate.customerPriceT.toString(),
    });
    const materialFinancials = calculateMaterialFinancials({
      saleSubtotal,
      factoryRate: estimate.rateT.toString(),
      dealerAffiliation: estimate.dealerAffiliationSnapshot,
      impactMarkupRate,
    });

    const order = await tx.order.create({
      data: {
        number: `ORD-${(lastOrder?.id ?? 0) + 1001}`,
        units: estimate.units,
        amount: payment.baseAmount,
        price: new Prisma.Decimal(saleSubtotal.toFixed(2)),
        saleSubtotal: new Prisma.Decimal(saleSubtotal.toFixed(2)),
        rate: estimate.rateT,
        netProfit: new Prisma.Decimal(
          materialFinancials.totalProfit.toFixed(2),
        ),
        dealerModeSnapshot: estimate.dealerModeSnapshot,
        dealerAffiliationSnapshot: estimate.dealerAffiliationSnapshot,
        impactMarkupRate: new Prisma.Decimal(impactMarkupRate.toFixed(18)),
        factoryPriceWithMarkup: new Prisma.Decimal(
          materialFinancials.factoryPriceWithMarkup.toFixed(2),
        ),
        impactProfit: new Prisma.Decimal(
          materialFinancials.impactProfit.toFixed(2),
        ),
        authenticProfit: new Prisma.Decimal(
          materialFinancials.authenticProfit.toFixed(2),
        ),
        poNumber: null,
        rateReal: null,
        netProfitReal: null,
        factoryPriceWithMarkupReal: null,
        impactProfitReal: null,
        authenticProfitReal: null,
        idEst: estimate.id,
        statusId: pendingStatus.id,
        userId: estimate.idUser,
        paymentId: payment.id,
      },
      include: { status: true },
    });

    await tx.estimate.update({
      where: { id: estimate.id },
      data: { statusId: orderedStatus.id },
    });

    await tx.eventLog.create({
      data: {
        action: 'CREATE',
        entityType: 'Order',
        entityId: order.id,
        userId: estimate.idUser,
        message: `Order #${order.number} created from paid material checkout.`,
      },
    });
    return true;
  }

  private async ensurePaidPaymentEffects(
    tx: Prisma.TransactionClient,
    payment: PaymentWithEstimate,
  ): Promise<boolean> {
    let changed = false;

    if (payment.type === PaymentType.MATERIAL) {
      changed =
        (await this.ensureOrderForMaterialPayment(tx, payment)) || changed;
    }

    changed =
      (await this.installationWorkflow.markPaymentPaid(tx, payment)) || changed;

    await this.notifyPaymentConfirmed(tx, payment);

    return changed;
  }

  private paymentNotificationCopy(type: PaymentType, sequence: number) {
    switch (type) {
      case PaymentType.INSTALLATION_DEPOSIT:
        return {
          label: 'Installation deposit',
          adminNextStep: 'Schedule remeasurement',
        };
      case PaymentType.PERMIT:
        return {
          label: 'Permit fee',
          adminNextStep: 'Continue permit processing',
        };
      case PaymentType.MATERIAL:
        return { label: 'Material payment', adminNextStep: 'Open order' };
      case PaymentType.INSTALLATION:
        return {
          label: 'Installation balance',
          adminNextStep: 'Schedule installation',
        };
      case PaymentType.EXTRA:
        return {
          label: `Extra charge #${sequence}`,
          adminNextStep: 'Open order',
        };
    }
  }

  private async notifyPaymentConfirmed(
    tx: Prisma.TransactionClient,
    payment: PaymentWithEstimate,
  ) {
    const copy = this.paymentNotificationCopy(payment.type, payment.sequence);
    const order = await tx.order.findUnique({
      where: { idEst: payment.idEst },
      select: { id: true },
    });
    const actionUrl = order
      ? `/orders/${order.id}`
      : payment.installationJobId
        ? `/installations/${payment.installationJobId}`
        : `/estimates/${payment.idEst}`;
    const payer = payment.payerName?.trim();
    const payerSuffix = payer ? ` from ${payer}` : '';

    await this.notifications.createAndSendToRoles(
      ['admin'],
      {
        message: `${copy.label} confirmed${payerSuffix} for Estimate #${payment.estimate.number}.`,
        actionUrl,
        actionLabel: copy.adminNextStep,
        dedupeKey: `payment:${payment.id}:paid:admin`,
      },
      {
        db: tx,
      },
    );

    if (
      payment.recordedById !== payment.estimate.idUser &&
      payment.estimate.user.role.name !== 'admin'
    ) {
      await this.notifications.createAndSend(
        {
          recipientId: payment.estimate.idUser,
          message: `${copy.label} was confirmed for Estimate #${payment.estimate.number}.`,
          actionUrl,
          actionLabel: order ? 'Open order' : 'View project',
          dedupeKey: `payment:${payment.id}:paid:owner`,
        },
        tx,
      );
    }
  }

  private async processPaidCheckoutSession(
    tx: Prisma.TransactionClient,
    session: Stripe.Checkout.Session,
  ): Promise<boolean> {
    if (session.payment_status !== 'paid') return false;

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null;
    const payment = await tx.payment.findUnique({
      where: { stripeSessionId: session.id },
      include: {
        estimate: {
          include: {
            order: true,
            status: true,
            user: { include: { role: true } },
          },
        },
      },
    });
    if (!payment) return false;

    if (payment.status === PaymentStatus.PAID) {
      await this.ensurePaidPaymentEffects(tx, payment);
      return true;
    }

    const stripeAmountCents = session.amount_total;
    const recordedAmountCents = Math.round(Number(payment.amount) * 100);
    const stripeCurrency = String(session.currency ?? '').toLowerCase();
    const recordedCurrency = payment.currency.toLowerCase();
    if (
      stripeAmountCents === null ||
      stripeAmountCents !== recordedAmountCents ||
      stripeCurrency !== recordedCurrency
    ) {
      throw new Error(
        `Paid checkout amount mismatch for Payment #${payment.id}.`,
      );
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.CARD,
        paidAt: new Date(),
        payerName: session.customer_details?.name ?? payment.payerName,
        payerEmail: session.customer_details?.email ?? payment.payerEmail,
        payerPhone: session.customer_details?.phone ?? payment.payerPhone,
        stripeCustomerId:
          typeof session.customer === 'string'
            ? session.customer
            : payment.stripeCustomerId,
        stripePaymentIntentId: paymentIntentId ?? payment.stripePaymentIntentId,
      },
    });

    await this.ensurePaidPaymentEffects(tx, payment);
    return true;
  }

  private async reconcilePaidPaymentEffects(): Promise<void> {
    const candidates = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PAID,
        OR: [
          {
            type: PaymentType.MATERIAL,
            order: { is: null },
          },
          {
            type: PaymentType.MATERIAL,
            estimate: {
              is: {
                status: { is: { name: { not: 'Ordered' } } },
              },
            },
          },
          {
            type: PaymentType.INSTALLATION_DEPOSIT,
            installationJob: {
              is: {
                status: InstallationJobStatus.DEPOSIT_PAYMENT_PENDING,
              },
            },
          },
          {
            type: PaymentType.PERMIT,
            installationJob: {
              is: {
                OR: [
                  { status: InstallationJobStatus.PERMIT_PAYMENT_PENDING },
                  {
                    permit: {
                      is: { status: InstallationPermitStatus.PAYMENT_PENDING },
                    },
                  },
                ],
              },
            },
          },
          {
            type: PaymentType.MATERIAL,
            installationJob: {
              is: {
                status: InstallationJobStatus.MATERIAL_PAYMENT_PENDING,
              },
            },
          },
          {
            type: PaymentType.INSTALLATION,
            installationJob: {
              is: {
                status: InstallationJobStatus.INSTALLATION_PAYMENT_PENDING,
              },
            },
          },
          {
            type: PaymentType.EXTRA,
            extraCharge: {
              is: { status: OrderExtraChargeStatus.PAYMENT_DUE },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });

    for (const candidate of candidates) {
      try {
        const repaired = await this.prisma.$transaction(async (tx) => {
          const payment = await tx.payment.findUnique({
            where: { id: candidate.id },
            include: {
              estimate: {
                include: {
                  order: true,
                  status: true,
                  user: { include: { role: true } },
                },
              },
            },
          });
          if (!payment || payment.status !== PaymentStatus.PAID) return false;

          const changed = await this.ensurePaidPaymentEffects(tx, payment);
          if (changed) {
            await tx.eventLog.create({
              data: {
                action: 'UPDATE',
                entityType: 'Payment',
                entityId: payment.id,
                userId: null,
                message: `Missing effects for paid ${payment.type} payment were reconciled automatically.`,
              },
            });
          }
          return changed;
        });

        if (repaired) {
          this.logger.warn(
            `Reconciled missing effects for paid Payment #${candidate.id}.`,
          );
        }
      } catch (error: unknown) {
        this.logger.error(
          `Error reconciling paid Payment #${candidate.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async closeUnpaidCheckoutSession(
    paymentId: number,
    stripeSessionId: string,
    finalStatus: PaymentStatus,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: {
        id: paymentId,
        status: { not: PaymentStatus.PAID },
        stripeSessionId,
      },
      data: {
        status: finalStatus,
        stripeSessionId: null,
        stripePaymentIntentId: null,
      },
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingCheckoutSessions(): Promise<void> {
    if (this.reconciliationInProgress) return;
    this.reconciliationInProgress = true;

    try {
      const pendingPayments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          stripeSessionId: { not: null },
        },
        select: { id: true, stripeSessionId: true },
        orderBy: { id: 'asc' },
      });

      for (const payment of pendingPayments) {
        const stripeSessionId = payment.stripeSessionId;
        if (!stripeSessionId) continue;

        try {
          const session =
            await this.stripe.checkout.sessions.retrieve(stripeSessionId);
          if (session.payment_status === 'paid') {
            const processed = await this.prisma.$transaction((tx) =>
              this.processPaidCheckoutSession(tx, session),
            );
            if (!processed) {
              this.logger.warn(
                `Paid Stripe session ${stripeSessionId} was not matched to a payment.`,
              );
            }
          } else if (session.status === 'expired') {
            await this.closeUnpaidCheckoutSession(
              payment.id,
              stripeSessionId,
              PaymentStatus.EXPIRED,
            );
          }
        } catch (error: unknown) {
          const stripeError =
            typeof error === 'object' && error !== null
              ? (error as { code?: string })
              : null;
          if (stripeError?.code === 'resource_missing') {
            await this.closeUnpaidCheckoutSession(
              payment.id,
              stripeSessionId,
              PaymentStatus.EXPIRED,
            );
            continue;
          }
          this.logger.error(
            `Error reconciling Payment #${payment.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      await this.reconcilePaidPaymentEffects();
    } finally {
      this.reconciliationInProgress = false;
    }
  }

  private async findPublicEstimateForPayment(
    token: string,
    tx: Prisma.TransactionClient,
  ) {
    const normalizedToken = String(token ?? '').trim();
    if (!normalizedToken || normalizedToken.length > 64) {
      throw new NotFoundException('Customer payment link not found.');
    }

    const estimate = await tx.estimate.findFirst({
      where: {
        publicTokenEnabled: true,
        OR: [
          { publicToken: normalizedToken },
          { publicTotalToken: normalizedToken },
        ],
      },
      include: {
        user: { include: { role: true } },
        status: true,
        order: {
          include: {
            extraCharges: {
              where: { status: OrderExtraChargeStatus.PAYMENT_DUE },
              orderBy: { sequence: 'asc' },
            },
          },
        },
        installationJob: { select: { id: true, status: true } },
      },
    });

    if (!estimate || estimate.user.role.name !== 'dealer') {
      throw new NotFoundException('Customer payment link not found.');
    }

    return { estimate, normalizedToken };
  }

  private resolveNextPaymentRequest(estimate: {
    status: { name: string };
    order: {
      extraCharges: Array<{ sequence: number }>;
    } | null;
    installationJob: {
      status: InstallationJobStatus;
    } | null;
  }): { type: PaymentType; sequence?: number } | null {
    const job =
      estimate.installationJob?.status === InstallationJobStatus.CANCELED
        ? null
        : estimate.installationJob;

    if (!job) {
      return !estimate.order && estimate.status.name === 'Active'
        ? { type: PaymentType.MATERIAL }
        : null;
    }

    if (job.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
      return { type: PaymentType.INSTALLATION_DEPOSIT };
    }
    if (job.status === InstallationJobStatus.PERMIT_PAYMENT_PENDING) {
      return { type: PaymentType.PERMIT };
    }
    if (job.status === InstallationJobStatus.MATERIAL_PAYMENT_PENDING) {
      return { type: PaymentType.MATERIAL };
    }
    if (job.status === InstallationJobStatus.INSTALLATION_PAYMENT_PENDING) {
      return { type: PaymentType.INSTALLATION };
    }

    const extraCharge = estimate.order?.extraCharges[0];
    return extraCharge
      ? { type: PaymentType.EXTRA, sequence: extraCharge.sequence }
      : null;
  }

  private publicPaymentTitle(type: PaymentType, sequence: number) {
    if (type === PaymentType.INSTALLATION_DEPOSIT) {
      return 'Installation deposit';
    }
    if (type === PaymentType.PERMIT) return 'Permit Fee';
    if (type === PaymentType.MATERIAL) return 'Material payment';
    if (type === PaymentType.INSTALLATION) return 'Installation balance';
    return `Extra charge #${sequence}`;
  }

  async getPublicPaymentContext(token: string) {
    return this.prisma.$transaction(async (tx) => {
      const { estimate } = await this.findPublicEstimateForPayment(token, tx);

      if (estimate.dealerModeSnapshot !== DealerMode.INTERNAL) {
        return {
          enabled: false as const,
          status: 'not_applicable' as const,
          payment: null,
        };
      }

      const request = this.resolveNextPaymentRequest(estimate);
      if (!request) {
        return {
          enabled: true as const,
          status: 'complete' as const,
          payment: null,
        };
      }

      const owner = {
        id: estimate.idUser,
        role: { name: 'dealer' as const },
      } satisfies AuthUser;
      const context = await this.installationWorkflow.getPaymentContext(
        estimate.id,
        request.type,
        request.sequence,
        undefined,
        owner,
        tx,
        { preview: true },
      );
      const existingPayment = await tx.payment.findUnique({
        where: {
          idEst_type_sequence: {
            idEst: estimate.id,
            type: request.type,
            sequence: context.paymentSequence,
          },
        },
        select: {
          status: true,
          stripeSessionId: true,
          paymentMethod: true,
          paidAt: true,
        },
      });

      return {
        enabled: true as const,
        status: 'due' as const,
        payment: {
          type: request.type,
          sequence: context.paymentSequence,
          title: this.publicPaymentTitle(request.type, context.paymentSequence),
          description: context.description,
          baseAmount: context.baseAmount.toFixed(2),
          surchargePercent: context.surchargePercent.toFixed(4),
          surchargeAmount: context.surchargeAmount.toFixed(2),
          totalAmount: context.totalAmount.toFixed(2),
          checkoutStarted: Boolean(
            existingPayment?.status === PaymentStatus.PENDING &&
              existingPayment.stripeSessionId,
          ),
          requiresTerms:
            request.type === PaymentType.INSTALLATION_DEPOSIT &&
            !context.job?.depositTermsAcceptedAt,
          terms:
            request.type === PaymentType.INSTALLATION_DEPOSIT
              ? context.job?.depositTermsSnapshot || INSTALLATION_DEPOSIT_TERMS
              : null,
        },
      };
    });
  }

  async createCheckoutSessionForPublicToken(params: {
    token: string;
    installationDepositTermsAccepted?: boolean;
  }) {
    const publicContext = await this.getPublicPaymentContext(params.token);
    if (!publicContext.enabled || !publicContext.payment) {
      throw new ConflictException('There is no payment due on this link.');
    }

    const owner = await this.prisma.estimate.findFirst({
      where: {
        publicTokenEnabled: true,
        dealerModeSnapshot: DealerMode.INTERNAL,
        OR: [{ publicToken: params.token }, { publicTotalToken: params.token }],
      },
      select: { id: true, idUser: true },
    });
    if (!owner) {
      throw new NotFoundException('Customer payment link not found.');
    }

    return this.createCheckoutSessionForEstimate({
      estimateId: owner.id,
      type: publicContext.payment.type,
      sequence: publicContext.payment.sequence,
      installationDepositTermsAccepted: params.installationDepositTermsAccepted,
      user: { id: owner.idUser, role: { name: 'dealer' } },
      publicToken: params.token,
    });
  }

  async createCheckoutSessionForEstimate(params: {
    estimateId: number;
    type?: PaymentType;
    sequence?: number;
    installationDepositTermsAccepted?: boolean;
    user: AuthUser;
    publicToken?: string;
  }) {
    const type = params.type ?? PaymentType.MATERIAL;

    return this.prisma.$transaction(async (tx) => {
      if (params.publicToken) {
        const publicEstimate = await tx.estimate.findFirst({
          where: {
            id: params.estimateId,
            publicTokenEnabled: true,
            dealerModeSnapshot: DealerMode.INTERNAL,
            OR: [
              { publicToken: params.publicToken },
              { publicTotalToken: params.publicToken },
            ],
          },
          select: { id: true },
        });
        if (!publicEstimate) {
          throw new NotFoundException('Customer payment link not found.');
        }
      }

      const context = await this.installationWorkflow.getPaymentContext(
        params.estimateId,
        type,
        params.sequence,
        params.installationDepositTermsAccepted,
        params.user,
        tx,
      );
      if (
        context.estimate.dealerModeSnapshot === DealerMode.INTERNAL &&
        !params.publicToken
      ) {
        throw new ConflictException(
          'Internal dealer charges must be paid by the final customer from the public share link.',
        );
      }
      const frontendUrl = this.getFrontendUrl();
      const query = params.publicToken
        ? `token=${encodeURIComponent(params.publicToken)}&type=${type}&sequence=${context.paymentSequence}`
        : `estimateId=${params.estimateId}&type=${type}&sequence=${context.paymentSequence}`;
      const successUrl = params.publicToken
        ? `${frontendUrl}/public/checkout/success?${query}`
        : `${frontendUrl}/checkout/success?${query}`;
      const cancelUrl = params.publicToken
        ? `${frontendUrl}/public/checkout/cancel?${query}`
        : `${frontendUrl}/checkout/cancel?${query}`;
      const payer = this.getPayerSnapshot(context.estimate);

      const existingPayment = await tx.payment.findUnique({
        where: {
          idEst_type_sequence: {
            idEst: params.estimateId,
            type,
            sequence: context.paymentSequence,
          },
        },
      });

      if (existingPayment?.stripeSessionId) {
        try {
          const existingSession = await this.stripe.checkout.sessions.retrieve(
            existingPayment.stripeSessionId,
          );
          if (existingSession.payment_status === 'paid') {
            const processed = await this.processPaidCheckoutSession(
              tx,
              existingSession,
            );
            if (!processed) {
              throw new BadRequestException(
                'Paid checkout could not be processed.',
              );
            }
            return { url: successUrl };
          }
          if (
            existingPayment.status === PaymentStatus.PENDING &&
            existingSession.status === 'open'
          ) {
            if (!existingSession.url) {
              throw new BadRequestException(
                'Stripe session has no checkout URL.',
              );
            }
            return { url: existingSession.url };
          }
          if (existingSession.status === 'complete') {
            throw new ConflictException(
              'Checkout completed, but Stripe payment confirmation is pending.',
            );
          }
        } catch (error: unknown) {
          const stripeError =
            typeof error === 'object' && error !== null
              ? (error as { code?: string })
              : null;
          if (stripeError?.code !== 'resource_missing') throw error;
        }
      }

      if (existingPayment?.status === PaymentStatus.PAID) {
        throw new ConflictException(`${type} payment is already paid.`);
      }

      const payment = await tx.payment.upsert({
        where: {
          idEst_type_sequence: {
            idEst: params.estimateId,
            type,
            sequence: context.paymentSequence,
          },
        },
        create: {
          idEst: params.estimateId,
          type,
          sequence: context.paymentSequence,
          installationJobId: context.job?.id ?? null,
          extraChargeId: context.extraCharge?.id ?? null,
          userId: context.estimate.idUser,
          ...payer,
          baseAmount: new Prisma.Decimal(context.baseAmount.toFixed(2)),
          surchargePercent: new Prisma.Decimal(
            context.surchargePercent.toFixed(4),
          ),
          surchargeAmount: new Prisma.Decimal(
            context.surchargeAmount.toFixed(2),
          ),
          amount: new Prisma.Decimal(context.totalAmount.toFixed(2)),
          currency: 'usd',
          status: PaymentStatus.PENDING,
          paymentMethod: PaymentMethod.CARD,
        },
        update: {
          installationJobId: context.job?.id ?? null,
          extraChargeId: context.extraCharge?.id ?? null,
          userId: context.estimate.idUser,
          ...payer,
          baseAmount: new Prisma.Decimal(context.baseAmount.toFixed(2)),
          surchargePercent: new Prisma.Decimal(
            context.surchargePercent.toFixed(4),
          ),
          surchargeAmount: new Prisma.Decimal(
            context.surchargeAmount.toFixed(2),
          ),
          amount: new Prisma.Decimal(context.totalAmount.toFixed(2)),
          currency: 'usd',
          status: PaymentStatus.PENDING,
          paymentMethod: PaymentMethod.CARD,
          paidAt: null,
          manualReference: null,
          manualNote: null,
          recordedById: null,
          stripeSessionId: null,
          stripePaymentIntentId: null,
        },
      });

      const surchargePercentLabel = context.surchargePercent
        .toFixed(4)
        .replace(/\.?0+$/, '');
      const cardFeeDescription = context.surchargeAmount.gt(0)
        ? `Card processing fee: ${surchargePercentLabel}% of $${context.baseAmount.toFixed(2)} = $${context.surchargeAmount.toFixed(2)}.`
        : '';

      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(context.totalAmount.toNumber() * 100),
              product_data: {
                name: context.description,
                description:
                  type === PaymentType.INSTALLATION_DEPOSIT
                    ? `${context.job?.depositTermsSnapshot || INSTALLATION_DEPOSIT_TERMS}${cardFeeDescription ? ` ${cardFeeDescription}` : ''}`
                    : cardFeeDescription || undefined,
              },
            },
          },
        ],
        metadata: {
          paymentId: String(payment.id),
          estimateId: String(params.estimateId),
          userId: String(context.estimate.idUser),
          paymentType: type,
          payerType: payer.payerType,
        },
        ...(payer.payerEmail ? { customer_email: payer.payerEmail } : {}),
      });
      if (!session.url) {
        throw new BadRequestException('Stripe session URL not returned.');
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { stripeSessionId: session.id },
      });
      return { url: session.url };
    });
  }

  async cancelCheckoutSessionForEstimate(params: {
    estimateId: number;
    type?: PaymentType;
    sequence?: number;
    user: AuthUser;
    publicToken?: string;
  }) {
    const type = params.type ?? PaymentType.MATERIAL;
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: params.estimateId },
      include: {
        order: true,
        payments: {
          where: {
            type,
            ...(params.sequence ? { sequence: params.sequence } : {}),
          },
          orderBy: { sequence: 'desc' },
          take: 1,
        },
      },
    });
    const publicTokenMatches =
      !params.publicToken ||
      (estimate?.publicTokenEnabled === true &&
        estimate.dealerModeSnapshot === DealerMode.INTERNAL &&
        (estimate.publicToken === params.publicToken ||
          estimate.publicTotalToken === params.publicToken));
    if (
      !estimate ||
      estimate.idUser !== params.user.id ||
      !publicTokenMatches
    ) {
      throw new NotFoundException(`Estimate #${params.estimateId} not found.`);
    }

    const payment = estimate.payments[0];
    if (!payment?.stripeSessionId) {
      return {
        status:
          payment?.status === PaymentStatus.PAID
            ? ('paid' as const)
            : ('canceled' as const),
        orderId: estimate.order?.id ?? null,
      };
    }

    const finalizePaid = async (session: Stripe.Checkout.Session) => {
      const processed = await this.prisma.$transaction((tx) =>
        this.processPaidCheckoutSession(tx, session),
      );
      if (!processed)
        throw new BadRequestException('Paid checkout could not be processed.');
      const order = await this.prisma.order.findUnique({
        where: { idEst: params.estimateId },
        select: { id: true },
      });
      return { status: 'paid' as const, orderId: order?.id ?? null };
    };

    const stripeSessionId = payment.stripeSessionId;
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(stripeSessionId);
    } catch (error: unknown) {
      const stripeError =
        typeof error === 'object' && error !== null
          ? (error as { code?: string })
          : null;
      if (stripeError?.code !== 'resource_missing') throw error;
      await this.closeUnpaidCheckoutSession(
        payment.id,
        stripeSessionId,
        PaymentStatus.CANCELED,
      );
      return {
        status: 'canceled' as const,
        orderId: estimate.order?.id ?? null,
      };
    }

    if (session.payment_status === 'paid') return finalizePaid(session);
    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(stripeSessionId);
      } catch (error) {
        const latest =
          await this.stripe.checkout.sessions.retrieve(stripeSessionId);
        if (latest.payment_status === 'paid') return finalizePaid(latest);
        if (latest.status !== 'expired') throw error;
      }
    } else if (session.status === 'complete') {
      throw new ConflictException(
        'Checkout completed, but payment confirmation is pending.',
      );
    }

    await this.closeUnpaidCheckoutSession(
      payment.id,
      stripeSessionId,
      PaymentStatus.CANCELED,
    );
    return { status: 'canceled' as const, orderId: estimate.order?.id ?? null };
  }

  async cancelCheckoutSessionForPublicToken(params: {
    token: string;
    type?: PaymentType;
    sequence?: number;
  }) {
    const owner = await this.prisma.estimate.findFirst({
      where: {
        publicTokenEnabled: true,
        dealerModeSnapshot: DealerMode.INTERNAL,
        OR: [{ publicToken: params.token }, { publicTotalToken: params.token }],
      },
      select: { id: true, idUser: true },
    });
    if (!owner) {
      throw new NotFoundException('Customer payment link not found.');
    }

    const result = await this.cancelCheckoutSessionForEstimate({
      estimateId: owner.id,
      type: params.type,
      sequence: params.sequence,
      user: { id: owner.idUser, role: { name: 'dealer' } },
      publicToken: params.token,
    });
    return { status: result.status };
  }

  private async closeStripeCheckoutBeforeManualPayment(payment: {
    id: number;
    status: PaymentStatus;
    stripeSessionId: string | null;
  }) {
    if (payment.status === PaymentStatus.PAID) {
      throw new ConflictException('This charge is already paid.');
    }
    if (!payment.stripeSessionId) return;

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(
        payment.stripeSessionId,
      );
    } catch (error: unknown) {
      const stripeError =
        typeof error === 'object' && error !== null
          ? (error as { code?: string })
          : null;
      if (stripeError?.code === 'resource_missing') return;
      throw error;
    }

    if (session.payment_status === 'paid') {
      await this.prisma.$transaction((tx) =>
        this.processPaidCheckoutSession(tx, session),
      );
      throw new ConflictException(
        'Stripe already confirmed this charge as paid.',
      );
    }
    if (session.status === 'complete') {
      throw new ConflictException(
        'Stripe checkout completed and confirmation is still pending.',
      );
    }
    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(session.id);
      } catch (error) {
        const latest = await this.stripe.checkout.sessions.retrieve(session.id);
        if (latest.payment_status === 'paid') {
          await this.prisma.$transaction((tx) =>
            this.processPaidCheckoutSession(tx, latest),
          );
          throw new ConflictException(
            'Stripe already confirmed this charge as paid.',
          );
        }
        if (latest.status !== 'expired') throw error;
      }
    }
  }

  async recordManualPayment(params: {
    estimateId: number;
    type: PaymentType;
    sequence?: number;
    method: PaymentMethod;
    fundsVerified: true;
    reference: string;
    note?: string;
    paidAt?: string;
    installationDepositTermsAccepted?: boolean;
    actor: AuthUser;
  }) {
    if (params.fundsVerified !== true) {
      throw new BadRequestException(
        'Confirm that the funds are already available before recording a manual payment.',
      );
    }
    if (params.method === PaymentMethod.CARD) {
      throw new BadRequestException(
        'CARD payments must be confirmed through Stripe.',
      );
    }
    const reference = params.reference.trim();
    if (!reference) {
      throw new BadRequestException(
        'A check number, transfer confirmation, or receipt reference is required.',
      );
    }

    const paidAt = params.paidAt ? new Date(params.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException('Invalid payment date.');
    }
    if (paidAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException('Payment date cannot be in the future.');
    }

    const owner = await this.prisma.estimate.findUnique({
      where: { id: params.estimateId },
      select: {
        id: true,
        idUser: true,
        dealerModeSnapshot: true,
        user: { select: { role: { select: { name: true } } } },
      },
    });
    if (!owner) {
      throw new NotFoundException(`Estimate #${params.estimateId} not found.`);
    }
    const actorRole = params.actor.role?.name;
    const isAdmin = actorRole === 'admin';
    const isInternalDealerOwner =
      actorRole === 'dealer' &&
      params.actor.id === owner.idUser &&
      owner.user.role.name === 'dealer' &&
      owner.dealerModeSnapshot === DealerMode.INTERNAL;

    if (!isAdmin && !isInternalDealerOwner) {
      throw new ForbiddenException(
        'Only administrators or the internal dealer who owns this estimate can record a manual payment.',
      );
    }
    const ownerUser = {
      id: owner.idUser,
      role: { name: owner.user.role.name as AuthUser['role']['name'] },
    } satisfies AuthUser;

    const preview = await this.prisma.$transaction((tx) =>
      this.installationWorkflow.getPaymentContext(
        params.estimateId,
        params.type,
        params.sequence,
        params.installationDepositTermsAccepted,
        ownerUser,
        tx,
        { preview: true },
      ),
    );
    const existingPayment = await this.prisma.payment.findUnique({
      where: {
        idEst_type_sequence: {
          idEst: params.estimateId,
          type: params.type,
          sequence: preview.paymentSequence,
        },
      },
      select: { id: true, status: true, stripeSessionId: true },
    });
    if (existingPayment) {
      await this.closeStripeCheckoutBeforeManualPayment(existingPayment);
    }

    return this.prisma.$transaction(async (tx) => {
      const context = await this.installationWorkflow.getPaymentContext(
        params.estimateId,
        params.type,
        params.sequence,
        params.installationDepositTermsAccepted,
        ownerUser,
        tx,
      );
      const current = await tx.payment.findUnique({
        where: {
          idEst_type_sequence: {
            idEst: params.estimateId,
            type: params.type,
            sequence: context.paymentSequence,
          },
        },
        select: { status: true },
      });
      if (current?.status === PaymentStatus.PAID) {
        throw new ConflictException('This charge is already paid.');
      }

      const payer = this.getPayerSnapshot(context.estimate);
      const baseAmount = new Prisma.Decimal(context.baseAmount.toFixed(2));
      const payment = await tx.payment.upsert({
        where: {
          idEst_type_sequence: {
            idEst: params.estimateId,
            type: params.type,
            sequence: context.paymentSequence,
          },
        },
        create: {
          idEst: params.estimateId,
          type: params.type,
          sequence: context.paymentSequence,
          installationJobId: context.job?.id ?? null,
          extraChargeId: context.extraCharge?.id ?? null,
          userId: context.estimate.idUser,
          ...payer,
          baseAmount,
          surchargePercent: new Prisma.Decimal(0),
          surchargeAmount: new Prisma.Decimal(0),
          amount: baseAmount,
          currency: 'usd',
          status: PaymentStatus.PAID,
          paymentMethod: params.method,
          paidAt,
          manualReference: reference,
          manualNote: params.note?.trim() || null,
          recordedById: params.actor.id,
        },
        update: {
          installationJobId: context.job?.id ?? null,
          extraChargeId: context.extraCharge?.id ?? null,
          userId: context.estimate.idUser,
          ...payer,
          baseAmount,
          surchargePercent: new Prisma.Decimal(0),
          surchargeAmount: new Prisma.Decimal(0),
          amount: baseAmount,
          currency: 'usd',
          status: PaymentStatus.PAID,
          paymentMethod: params.method,
          paidAt,
          manualReference: reference,
          manualNote: params.note?.trim() || null,
          recordedById: params.actor.id,
          stripeSessionId: null,
          stripePaymentIntentId: null,
          stripeCustomerId: null,
        },
      });
      const paymentWithEstimate = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: {
          estimate: {
            include: {
              order: true,
              status: true,
              user: { include: { role: true } },
            },
          },
        },
      });
      await this.ensurePaidPaymentEffects(tx, paymentWithEstimate);
      await tx.eventLog.create({
        data: {
          action: 'CREATE',
          entityType: 'Payment',
          entityId: payment.id,
          userId: params.actor.id,
          message: `${params.type} payment recorded as paid by ${params.method}.`,
          tempLog: {
            create: {
              meta: {
                source: 'manual',
                fundsVerified: true,
                reference,
                paidAt: paidAt.toISOString(),
                payerType: payer.payerType,
              },
            },
          },
        },
      });

      return tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { order: true },
      });
    });
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set in .env');
    if (!signature) throw new BadRequestException('Missing Stripe signature');

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.prisma.$transaction((tx) =>
        this.processPaidCheckoutSession(tx, session),
      );
    }
    return { received: true };
  }
}

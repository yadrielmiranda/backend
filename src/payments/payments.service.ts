import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { INSTALLATION_DEPOSIT_TERMS } from '@/installation/installation-workflow.service';

@Injectable()
export class PaymentsService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(PaymentsService.name);
  private reconciliationInProgress = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly installationWorkflow: InstallationWorkflowService,
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

  private async createOrderForMaterialPayment(
    tx: Prisma.TransactionClient,
    payment: Prisma.PaymentGetPayload<{
      include: {
        estimate: {
          include: { order: true; status: true };
        };
      };
    }>,
  ) {
    const estimate = payment.estimate;
    if (estimate.order) return estimate.order;
    if (estimate.status.name !== 'Active') {
      throw new Error(
        `Estimate #${estimate.number} is not active for material-order creation.`,
      );
    }

    const [pendingStatus, orderedStatus, lastOrder] = await Promise.all([
      tx.orderStatus.findUnique({ where: { name: 'Pending' } }),
      tx.estimateStatus.findUnique({ where: { name: 'Ordered' } }),
      tx.order.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }),
    ]);
    if (!pendingStatus) throw new Error('Order status "Pending" not seeded.');
    if (!orderedStatus) throw new Error('Estimate status "Ordered" not seeded.');

    const order = await tx.order.create({
      data: {
        number: `ORD-${(lastOrder?.id ?? 0) + 1001}`,
        units: estimate.units,
        amount: payment.baseAmount,
        price: estimate.priceT,
        rate: estimate.rateT,
        netProfit: estimate.netProfit,
        poNumber: null,
        rateReal: null,
        netProfitReal: null,
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
    return order;
  }

  private async processPaidCheckoutSession(
    tx: Prisma.TransactionClient,
    session: Stripe.Checkout.Session,
  ): Promise<boolean> {
    if (session.payment_status !== 'paid') return false;

    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : null;
    const payment = await tx.payment.findUnique({
      where: { stripeSessionId: session.id },
      include: {
        estimate: { include: { order: true, status: true } },
      },
    });
    if (!payment) return false;

    if (payment.status === PaymentStatus.PAID) {
      if (payment.type === PaymentType.MATERIAL) {
        await this.createOrderForMaterialPayment(tx, payment);
      }
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
        stripePaymentIntentId:
          paymentIntentId ?? payment.stripePaymentIntentId,
      },
    });

    if (payment.type === PaymentType.MATERIAL) {
      await this.createOrderForMaterialPayment(tx, payment);
    }
    await this.installationWorkflow.markPaymentPaid(tx, payment);
    return true;
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
          const session = await this.stripe.checkout.sessions.retrieve(
            stripeSessionId,
          );
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
    } finally {
      this.reconciliationInProgress = false;
    }
  }

  async createCheckoutSessionForEstimate(params: {
    estimateId: number;
    type?: PaymentType;
    sequence?: number;
    installationDepositTermsAccepted?: boolean;
    user: AuthUser;
  }) {
    const type = params.type ?? PaymentType.MATERIAL;

    return this.prisma.$transaction(async (tx) => {
      const context = await this.installationWorkflow.getPaymentContext(
        params.estimateId,
        type,
        params.sequence,
        params.installationDepositTermsAccepted,
        params.user,
        tx,
      );
      const frontendUrl = this.getFrontendUrl();
      const query = `estimateId=${params.estimateId}&type=${type}&sequence=${context.paymentSequence}`;
      const successUrl = `${frontendUrl}/checkout/success?${query}`;
      const cancelUrl = `${frontendUrl}/checkout/cancel?${query}`;

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
              throw new BadRequestException('Paid checkout could not be processed.');
            }
            return { url: successUrl };
          }
          if (
            existingPayment.status === PaymentStatus.PENDING &&
            existingSession.status === 'open'
          ) {
            if (!existingSession.url) {
              throw new BadRequestException('Stripe session has no checkout URL.');
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
          userId: params.user.id,
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
        },
        update: {
          installationJobId: context.job?.id ?? null,
          extraChargeId: context.extraCharge?.id ?? null,
          userId: params.user.id,
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
          stripeSessionId: null,
          stripePaymentIntentId: null,
        },
      });

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
                    ? `${context.job?.depositTermsSnapshot || INSTALLATION_DEPOSIT_TERMS}${
                        context.surchargeAmount.gt(0)
                          ? ` Includes $${context.surchargeAmount.toFixed(2)} card surcharge.`
                          : ''
                      }`
                    : context.surchargeAmount.gt(0)
                    ? `Includes $${context.surchargeAmount.toFixed(2)} card surcharge.`
                    : undefined,
              },
            },
          },
        ],
        metadata: {
          paymentId: String(payment.id),
          estimateId: String(params.estimateId),
          userId: String(params.user.id),
          paymentType: type,
        },
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
    if (!estimate || estimate.idUser !== params.user.id) {
      throw new NotFoundException(`Estimate #${params.estimateId} not found.`);
    }

    const payment = estimate.payments[0];
    if (!payment?.stripeSessionId) {
      return {
        status: payment?.status === PaymentStatus.PAID ? ('paid' as const) : ('canceled' as const),
        orderId: estimate.order?.id ?? null,
      };
    }

    const finalizePaid = async (session: Stripe.Checkout.Session) => {
      const processed = await this.prisma.$transaction((tx) =>
        this.processPaidCheckoutSession(tx, session),
      );
      if (!processed) throw new BadRequestException('Paid checkout could not be processed.');
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
      return { status: 'canceled' as const, orderId: estimate.order?.id ?? null };
    }

    if (session.payment_status === 'paid') return finalizePaid(session);
    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(stripeSessionId);
      } catch (error) {
        const latest = await this.stripe.checkout.sessions.retrieve(
          stripeSessionId,
        );
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

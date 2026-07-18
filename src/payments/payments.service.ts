// @/payments/payments.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { LogsService } from '@/logs/logs.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class PaymentsService {
  private stripe: Stripe;
  private readonly logger = new Logger(PaymentsService.name);
  private reconciliationInProgress = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private logsService: LogsService,
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

  private async processPaidCheckoutSession(
    tx: Prisma.TransactionClient,
    session: Stripe.Checkout.Session,
  ): Promise<boolean> {
    // Nunca crea una orden si Stripe no confirma el pago.
    if (session.payment_status !== 'paid') {
      return false;
    }

    const stripeSessionId = session.id;

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null;

    const payment = await tx.payment.findUnique({
      where: { stripeSessionId },
      include: {
        estimate: {
          include: {
            order: true,
            status: true,
          },
        },
      },
    });

    if (!payment) {
      return false;
    }

    const estimate = payment.estimate;

    // La orden ya fue creada anteriormente.
    if (estimate.order) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          stripePaymentIntentId:
            paymentIntentId ?? payment.stripePaymentIntentId,
        },
      });

      return true;
    }

    if (estimate.status?.name !== 'Active') {
      return false;
    }

    const stripeAmountCents = session.amount_total;
    const recordedAmountCents = Math.round(
      Number(payment.amount) * 100,
    );
    const currentEstimateAmountCents = Math.round(
      Number(estimate.totalPayable) * 100,
    );

    const stripeCurrency = String(
      session.currency ?? '',
    ).toLowerCase();

    const recordedCurrency = String(
      payment.currency,
    ).toLowerCase();

    if (
      stripeAmountCents === null ||
      stripeAmountCents !== recordedAmountCents ||
      stripeAmountCents !== currentEstimateAmountCents ||
      stripeCurrency !== recordedCurrency
    ) {
      throw new Error(
        `Paid checkout amount mismatch for Estimate #${estimate.number}.`,
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

    const pendingStatus = await tx.orderStatus.findUnique({
      where: { name: 'Pending' },
      select: { id: true, name: true },
    });

    if (!pendingStatus) {
      throw new Error('Order status "Pending" not seeded.');
    }

    const orderedStatus = await tx.estimateStatus.findUnique({
      where: { name: 'Ordered' },
      select: { id: true },
    });

    if (!orderedStatus) {
      throw new Error('Estimate status "Ordered" not seeded.');
    }

    const lastOrder = await tx.order.findFirst({
      orderBy: { id: 'desc' },
    });

    const newOrderNumber = `ORD-${(lastOrder?.id ?? 0) + 1001}`;

    const createdOrder = await tx.order.create({
      data: {
        number: newOrderNumber,
        units: estimate.units,

        amount: estimate.totalPayable,
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
      data: {
        status: {
          connect: { id: orderedStatus.id },
        },
      },
    });

    await this.logsService.log({
      action: 'CREATE',
      entityType: 'Order',
      entityId: createdOrder.id,
      userId: estimate.idUser,
      message: `Order #${createdOrder.number} created (paid via Stripe)`,
      before: null,
      after: {
        id: createdOrder.id,
        number: createdOrder.number,
        statusId: createdOrder.statusId,
        statusName: createdOrder.status?.name ?? 'Pending',
        estimateId: createdOrder.idEst,
        ownerUserId: createdOrder.userId,
        amount: createdOrder.amount,
      },
      meta: {
        actor: 'system/stripe',
        responsibleUserId: estimate.idUser,
        stripeSessionId,
        paymentId: payment.id,
        source: 'PaymentsService.processPaidCheckoutSession',
      },
    });

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
        status: {
          not: PaymentStatus.PAID,
        },
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
    if (this.reconciliationInProgress) {
      return;
    }

    this.reconciliationInProgress = true;

    try {
      const pendingPayments =
        await this.prisma.payment.findMany({
          where: {
            status: PaymentStatus.PENDING,
            stripeSessionId: {
              not: null,
            },
          },
          select: {
            id: true,
            stripeSessionId: true,
          },
          orderBy: {
            id: 'asc',
          },
        });

      for (const payment of pendingPayments) {
        const stripeSessionId = payment.stripeSessionId;

        if (!stripeSessionId) {
          continue;
        }

        try {
          const session =
            await this.stripe.checkout.sessions.retrieve(
              stripeSessionId,
            );

          if (session.payment_status === 'paid') {
            const processed =
              await this.prisma.$transaction(async (tx) => {
                return this.processPaidCheckoutSession(
                  tx,
                  session,
                );
              });

            if (!processed) {
              this.logger.warn(
                `Paid Stripe session ${stripeSessionId} could not be converted into an order automatically.`,
              );
            }

            continue;
          }

          if (session.status === 'expired') {
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

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          this.logger.error(
            `Error reconciling Payment #${payment.id}: ${message}`,
          );
        }
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.error(
        `Unable to load pending payments for reconciliation: ${message}`,
      );
    } finally {
      this.reconciliationInProgress = false;
    }
  }

  async createCheckoutSessionForEstimate(params: { estimateId: number; user: AuthUser }) {
    const { estimateId, user } = params;

    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          order: true,
          status: { select: { name: true } },
          payment: true,
        },
      });

      if (!estimate) throw new NotFoundException(`Estimate #${estimateId} not found.`);

      if (estimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate #${estimateId} not found.`);
      }

      if (estimate.order) {
        throw new ConflictException(`Estimate #${estimateId} already has an order.`);
      }

      if (estimate.status?.name !== 'Active') {
        throw new BadRequestException(
          `Estimate #${estimateId} cannot be paid (status: ${estimate.status?.name ?? 'UNKNOWN'}).`,
        );
      }

      const frontendUrl = this.getFrontendUrl();

      const successUrl =
        `${frontendUrl}/checkout/success?estimateId=${estimateId}`;

      const cancelUrl =
        `${frontendUrl}/checkout/cancel?estimateId=${estimateId}`;

      if (estimate.payment?.stripeSessionId) {
        try {
          const existingSession =
            await this.stripe.checkout.sessions.retrieve(
              estimate.payment.stripeSessionId,
            );

          if (existingSession.payment_status === 'paid') {
            const processed = await this.processPaidCheckoutSession(
              tx,
              existingSession,
            );

            if (!processed) {
              throw new BadRequestException(
                `Paid checkout for estimate #${estimate.number} could not be processed.`,
              );
            }

            return { url: successUrl };
          }

          if (estimate.payment.status === PaymentStatus.PENDING) {
            if (existingSession.status === 'open') {
              if (!existingSession.url) {
                throw new BadRequestException(
                  'Stripe session is open but has no checkout URL.',
                );
              }

              return { url: existingSession.url };
            }

            if (existingSession.status === 'complete') {
              throw new ConflictException(
                `Estimate #${estimate.number} checkout completed, but Stripe has not confirmed the payment.`,
              );
            }

            if (existingSession.status !== 'expired') {
              throw new ConflictException(
                `Estimate #${estimate.number} has a checkout session with status: ${existingSession.status ?? 'UNKNOWN'
                }.`,
              );
            }
          }
        } catch (error: unknown) {
          const stripeError =
            typeof error === 'object' && error !== null
              ? (error as { code?: string })
              : null;

          if (stripeError?.code !== 'resource_missing') {
            throw error;
          }
        }
      }

      if (estimate.payment?.status === PaymentStatus.PAID) {
        throw new ConflictException(
          `Estimate #${estimate.number} is already paid.`,
        );
      }

      const amount = Number(estimate.totalPayable);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('Invalid estimate totalPayable.');
      }

      const amountCents = Math.round(amount * 100);

      const payment = await tx.payment.upsert({
        where: { idEst: estimateId },
        create: {
          idEst: estimateId,
          userId: user.id,
          amount: new Prisma.Decimal(amount.toFixed(2)),
          currency: 'usd',
          status: PaymentStatus.PENDING,
        },
        update: {
          userId: user.id,
          amount: new Prisma.Decimal(amount.toFixed(2)),
          currency: 'usd',
          status: PaymentStatus.PENDING,
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
              unit_amount: amountCents,
              product_data: {
                name: `Estimate #${estimate.number}`,
                description: estimate.name,
              },
            },
          },
        ],
        metadata: {
          paymentId: String(payment.id),
          estimateId: String(estimateId),
          userId: String(user.id),
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
    user: AuthUser;
  }) {
    const { estimateId, user } = params;

    const estimate = await this.prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        order: true,
        payment: true,
      },
    });

    if (!estimate || estimate.idUser !== user.id) {
      throw new NotFoundException(
        `Estimate #${estimateId} not found.`,
      );
    }

    if (estimate.order) {
      return {
        status: 'paid' as const,
        orderId: estimate.order.id,
      };
    }

    const payment = estimate.payment;

    if (!payment?.stripeSessionId) {
      if (payment?.status === PaymentStatus.PAID) {
        throw new ConflictException(
          `Estimate #${estimate.number} is already paid.`,
        );
      }

      return {
        status: 'canceled' as const,
        orderId: null,
      };
    }

    const stripeSessionId = payment.stripeSessionId;

    const finalizePaidSession = async (
      session: Stripe.Checkout.Session,
    ) => {
      const processed = await this.prisma.$transaction(
        async (tx) => {
          return this.processPaidCheckoutSession(tx, session);
        },
      );

      if (!processed) {
        throw new BadRequestException(
          `Paid checkout for Estimate #${estimate.number} could not be processed.`,
        );
      }

      const order = await this.prisma.order.findFirst({
        where: { idEst: estimateId },
        select: { id: true },
      });

      return {
        status: 'paid' as const,
        orderId: order?.id ?? null,
      };
    };

    let session: Stripe.Checkout.Session;

    try {
      session =
        await this.stripe.checkout.sessions.retrieve(
          stripeSessionId,
        );
    } catch (error: unknown) {
      const stripeError =
        typeof error === 'object' && error !== null
          ? (error as { code?: string })
          : null;

      if (stripeError?.code !== 'resource_missing') {
        throw error;
      }

      await this.closeUnpaidCheckoutSession(
        payment.id,
        stripeSessionId,
        PaymentStatus.CANCELED,
      );

      return {
        status: 'canceled' as const,
        orderId: null,
      };
    }

    if (session.payment_status === 'paid') {
      return finalizePaidSession(session);
    }

    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(
          stripeSessionId,
        );
      } catch (error) {
        // El pago pudo completarse mientras intentábamos cancelarlo.
        const latestSession =
          await this.stripe.checkout.sessions.retrieve(
            stripeSessionId,
          );

        if (latestSession.payment_status === 'paid') {
          return finalizePaidSession(latestSession);
        }

        if (latestSession.status !== 'expired') {
          throw error;
        }
      }
    } else if (session.status === 'complete') {
      throw new ConflictException(
        `Estimate #${estimate.number} checkout completed, but payment confirmation is still pending.`,
      );
    } else if (session.status !== 'expired') {
      throw new ConflictException(
        `Estimate #${estimate.number} checkout cannot be canceled (status: ${session.status ?? 'UNKNOWN'
        }).`,
      );
    }

    await this.closeUnpaidCheckoutSession(
      payment.id,
      stripeSessionId,
      PaymentStatus.CANCELED,
    );

    return {
      status: 'canceled' as const,
      orderId: null,
    };
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

    if (event.type !== 'checkout.session.completed') {
      return { received: true };
    }

    const session = event.data.object as Stripe.Checkout.Session;
    await this.prisma.$transaction(async (tx) => {
      await this.processPaidCheckoutSession(tx, session);
    });

    return { received: true };
  }
}

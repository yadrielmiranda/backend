// @/payments/payments.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { LogsService } from '@/logs/logs.service'; 

@Injectable()
export class PaymentsService {
  private stripe: Stripe;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private logsService: LogsService, 
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set in .env');

    this.stripe = new Stripe(key);
  }

  private getAppUrl(): string {
    const appUrl =
      this.config.get<string>('APP_URL') ||
      this.config.get<string>('NEXT_PUBLIC_APP_URL') ||
      'http://localhost:3000';

    return String(appUrl).replace(/\/+$/, '');
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

      if (estimate.payment?.status === PaymentStatus.PAID) {
        throw new ConflictException(`Estimate #${estimateId} is already paid.`);
      }

      if (
        estimate.payment?.status === PaymentStatus.PENDING &&
        estimate.payment?.stripeSessionId
      ) {
        throw new ConflictException(
          `Estimate #${estimateId} already has a pending checkout session.`,
        );
      }

      const amount = Number(estimate.totalPayable);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('Invalid estimate totalPayable.');
      }

      const amountCents = Math.round(amount * 100);
      const appUrl = this.getAppUrl();

      const successUrl = `${appUrl}/checkout/success?estimateId=${estimateId}`;
      const cancelUrl = `${appUrl}/checkout/cancel?estimateId=${estimateId}`;

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
    const stripeSessionId = session.id;

    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : null;

    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { stripeSessionId },
        include: { estimate: { include: { order: true, status: true } } },
      });

      if (!payment) return;
      if (payment.status === PaymentStatus.PAID) return;

      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          stripePaymentIntentId: paymentIntentId ?? payment.stripePaymentIntentId,
        },
      });

      const estimate = payment.estimate;

      if (estimate.order) return;
      if (estimate.status?.name !== 'Active') return;

      const pendingStatus = await tx.orderStatus.findUnique({
        where: { name: 'Pending' },
        select: { id: true, name: true },
      });
      if (!pendingStatus) throw new Error('Order status "Pending" not seeded.');

      const ordered = await tx.estimateStatus.findUnique({
        where: { name: 'Ordered' },
        select: { id: true },
      });
      if (!ordered) throw new Error('Estimate status "Ordered" not seeded.');

      const lastOrder = await tx.order.findFirst({ orderBy: { id: 'desc' } });
      const newOrderNumber = `ORD-${(lastOrder?.id ?? 0) + 1001}`;

      //  CAPTURAMOS LA ORDEN CREADA
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

          paymentId: updatedPayment.id,
        },
        include: { status: true },
      });

      await tx.estimate.update({
        where: { id: estimate.id },
        data: { status: { connect: { id: ordered.id } } },
      });

      // 
      await this.logsService.log({
  action: 'CREATE',
  entityType: 'Order',
  entityId: createdOrder.id,

  // responsable / owner del estimate
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
    actor: 'system/stripe-webhook', // quién lo ejecutó técnicamente
    responsibleUserId: estimate.idUser, // explícito (por si en el futuro cambia la lógica)
    stripeSessionId,
    paymentId: updatedPayment.id,
    source: 'PaymentsService.handleStripeWebhook',
  },
});

    });

    return { received: true };
  }
}

import { assertNoPendingMaterialRevision } from '@/estimates/material-revisions/material-revision-policy';
import { cents, hasRefundHistory, paidPrincipal, paymentIsCovered, remainingRefundBalance } from './payment-accounting';
import { reconcileChargeRefunds, recordManualReceipt, recordStripeReceipt, refreshPaymentAccounting } from './payment-ledger';
import { stripePaymentMethod } from './stripe-payment-method';
import { ReviewRefundDto } from './dto/review-refund.dto';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { PENDING_ORDER_REVIEW } from '@/payment-plans/payment-plan';
import { getPaymentSchedule, refreshScheduledInstallation, scheduleInclude } from '@/payment-plans/payment-schedule';
import { calculateEstimateDiscount, estimateDiscountConfig } from '@/estimates/discounts/estimate-discount';
import { checkoutPromotionExpiry, promotionExpired, promotionTerms } from '@/promotions/promotion-pricing';
import { getAgreementPaymentRequirement, requireSignedAgreementForPayment } from '@/contracts/agreement-payment';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { refreshDraftEarningsPlan } from '@/earnings-plans/estimate-earnings-plan';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DealerMode,
  DeliveryStatus,
  InstallationJobStatus,
  InstallationPermitStatus,
  OrderExtraChargeStatus,
  OrderFulfillmentMethod,
  PaymentMethod,
  PaymentPayerType,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
// Importación compatible con CommonJS y Stripe Node 22.
import Stripe = require('stripe');
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { INSTALLATION_DEPOSIT_TERMS } from '@/installation/installation-workflow.service';
import {
  calculateMaterialFinancials,
  resolveMaterialSaleSubtotal,
} from '@/orders/order-material-financials';
import { NotificationsService } from '@/notifications/notifications.service';

const MATERIAL_ACCEPTANCE_TEXT =
  'I have reviewed and accept the products, dimensions, configurations and prices in this estimate.';

type UnavailablePublicPaymentContext = {
  enabled: boolean; status: 'not_applicable' | 'expired'; payment: null;
  payments?: never; fullBalance?: never; checkouts?: never;
  installmentCheckouts?: never; schedule?: never; agreement?: never;
};

type PaymentSelection = { type: PaymentType; sequence: number };
const paymentSelectionKey = (item: { type: PaymentType; sequence?: number }) => `${item.type}:${item.sequence}`;

type PaymentWithEstimate = Prisma.PaymentGetPayload<{
  include: {
    estimate: {
      include: {
        order: true;
        installationJob: true;
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
    this.stripe = new Stripe(key, {
      apiVersion: '2026-08-26.dahlia',
    });
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

  private async ensureOrderForInitialPayment(
    tx: Prisma.TransactionClient,
    payment: PaymentWithEstimate,
    approvedBy?: AuthUser,
  ): Promise<boolean> {
    const estimate = payment.estimate;
    if (payment.type === PaymentType.INSTALLMENT) {
      const schedule = await getPaymentSchedule(tx, payment.idEst);
      if (!schedule || schedule.initialSequence !== payment.sequence) return false;
    }

    if (estimate.order) {
      if (estimate.order.paymentId !== payment.id) {
        throw new Error(
          `Order #${estimate.order.number} is linked to another payment.`,
        );
      }
      if (estimate.status.name === 'Ordered') return false;
      if (!['Active', PENDING_ORDER_REVIEW].includes(estimate.status.name)) {
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

    if (estimate.installationJob && estimate.installationJob.status !== InstallationJobStatus.CANCELED && !approvedBy) {
      if (estimate.status.name === PENDING_ORDER_REVIEW) return false;
      if (estimate.status.name !== 'Active') throw new ConflictException('This paid estimate requires administrative review.');
      const reviewStatus = await tx.estimateStatus.upsert({
        where: { name: PENDING_ORDER_REVIEW }, update: {}, create: { name: PENDING_ORDER_REVIEW },
      });
      await tx.estimate.update({ where: { id: estimate.id }, data: { statusId: reviewStatus.id } });
      estimate.status = reviewStatus;
      await tx.eventLog.create({ data: {
        action: 'UPDATE', entityType: 'Estimate', entityId: estimate.id,
        userId: payment.recordedById ?? estimate.idUser,
        message: 'First order payment confirmed. Pending order review; no order has been created.',
      } });
      await this.notifications.createAndSend({
        recipientId: estimate.idUser, actorId: payment.recordedById ?? estimate.idUser, notifyActor: true,
        message: `Payment confirmed for Estimate #${estimate.number}. Pending order review.`,
        actionUrl: `/estimates/${estimate.id}/edit`, actionLabel: 'View estimate',
        dedupeKey: `estimate:${estimate.id}:order-review:owner`,
      }, tx);
      return true;
    }
    // Una revisión pendiente solo puede finalizar desde la acción administrativa.
    if (estimate.status.name === PENDING_ORDER_REVIEW && !approvedBy) return false;
    if (!['Active', 'Ordered', PENDING_ORDER_REVIEW].includes(estimate.status.name)) {
      throw new Error(
        `Estimate #${estimate.number} cannot create its paid material order from status ${estimate.status.name}.`,
      );
    }

    const [pendingStatus, orderedStatus] = await Promise.all([
      tx.orderStatus.findUnique({ where: { name: 'Pending' } }),
      tx.estimateStatus.findUnique({ where: { name: 'Ordered' } }),
    ]);
    if (!pendingStatus) throw new Error('Order status "Pending" not seeded.');
    if (!orderedStatus)
      throw new Error('Estimate status "Ordered" not seeded.');

    const manualDiscount = calculateEstimateDiscount(estimate);
    const saleSubtotal = manualDiscount
      ? new Prisma.Decimal(manualDiscount.material.subtotal)
      : resolveMaterialSaleSubtotal({
      dealerMode: estimate.dealerModeSnapshot,
      priceT: estimate.priceT.toString(),
      customerPriceT: estimate.customerPriceT.toString(),
    });
    const materialFinancials = calculateMaterialFinancials({
      saleSubtotal,
      factoryRate: estimate.rateT.toString(),
    });

    // Reserva un número único dentro de la misma transacción que crea la orden.
    const sequence = await tx.orderSequence.create({ data: {} });

    const order = await tx.order.create({
      data: {
        number: `ORD-${1000 + sequence.id}`,
        units: estimate.units,
        amount: payment.baseAmount,
        price: new Prisma.Decimal(saleSubtotal.toFixed(2)),
        saleSubtotal: new Prisma.Decimal(saleSubtotal.toFixed(2)),
        rate: estimate.rateT,
        netProfit: new Prisma.Decimal(
          materialFinancials.totalProfit.toFixed(2),
        ),
        dealerModeSnapshot: estimate.dealerModeSnapshot,
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
        userId: approvedBy?.id ?? estimate.idUser,
        message: approvedBy ? `Order #${order.number} created after administrative review of the paid estimate.` : `Order #${order.number} created from paid material checkout.`,
      },
    });
    // La orden creada sí se avisa al dueño, aunque él haya iniciado el pago.
    await this.notifications.createAndSend(
      {
        recipientId: estimate.idUser,
        actorId: approvedBy?.id ?? payment.recordedById ?? estimate.idUser,
        notifyActor: true,
        message: `Your order #${order.number} has been created from Estimate #${estimate.number}.`,
        actionUrl: `/orders/${order.id}`,
        actionLabel: 'Open order',
        dedupeKey: `order:${order.id}:created:owner`,
      },
      tx,
    );
    return true;
  }

  async approveOrder(estimateId: number, actor: AuthUser) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Only administrators can approve an order.');
    return this.prisma.$transaction(async (tx) => {
      // Serializa aprobación, cobros y cambios del proyecto; un reintento devuelve la misma orden.
      await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
      const estimate = await tx.estimate.findUnique({ where: { id: estimateId }, include: scheduleInclude });
      if (!estimate) throw new NotFoundException('Estimate not found.');
      if (estimate.order) return estimate.order;
      await assertNoPendingMaterialRevision(tx, estimateId);
      if (estimate.status.name !== PENDING_ORDER_REVIEW) throw new ConflictException('This estimate is not pending order review.');
      if (estimate.units <= 0) throw new ConflictException('At least one material unit is required to create an order.');
      const job = estimate.installationJob?.status === InstallationJobStatus.CANCELED ? null : estimate.installationJob;
      if (job && job.quotes[0]?.status !== 'APPROVED') throw new ConflictException('Approve the installation quote before creating the order.');
      const schedule = await getPaymentSchedule(tx, estimateId);
      if (schedule?.orderReviewBlockedReason) throw new ConflictException(schedule.orderReviewBlockedReason);
      const firstPayment = estimate.payments.find(p => (schedule ? !p.refundReviewPending && (p.paidAt != null || p.status === PaymentStatus.PAID) : paymentIsCovered(p)) &&
        (schedule ? p.type === PaymentType.INSTALLMENT && p.sequence === schedule.initialSequence : p.type === PaymentType.MATERIAL));
      if (!firstPayment) throw new ConflictException('The first order payment must be confirmed before approval.');
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: firstPayment.id }, include: {
        estimate: { include: { order: true, status: true, installationJob: true, user: { include: { role: true } } } },
      } });
      await this.ensureOrderForInitialPayment(tx, payment, actor);
      if (schedule) await refreshScheduledInstallation(tx, estimateId);
      return tx.order.findUniqueOrThrow({ where: { idEst: estimateId }, include: { status: true } });
    });
  }

  private async acceptCityFee(
    tx: Prisma.TransactionClient,
    context: { requiresCityFeeAcceptance?: boolean; cityFeeAmount?: string; baseAmount: { toFixed(n: number): string }; paymentSequence: number },
    accepted: boolean | undefined, estimateId: number, actorId: number, manual = false,
  ) {
    if (!context.requiresCityFeeAcceptance) return;
    if (accepted !== true) throw new BadRequestException('Review and accept the City Fee adjustment before payment.');
    await tx.eventLog.create({ data: {
      action: 'APPROVE', entityType: 'Estimate', entityId: estimateId, userId: actorId,
      message: `${manual ? 'Staff confirmed customer acceptance of' : 'Payer accepted'} City Fee adjustment #${context.paymentSequence}: $${context.cityFeeAmount ?? context.baseAmount.toFixed(2)}. Amount due after credits: $${context.baseAmount.toFixed(2)}.`,
    } });
  }

  private isCompletedCheckout(session: {payment_status: string; status: string | null; amount_total: number | null}) {
    return session.payment_status === 'paid' || (session.status === 'complete' && session.payment_status === 'no_payment_required' && session.amount_total === 0);
  }

  private async advanceAwaitingReleaseOrder(
    tx: Prisma.TransactionClient,
    estimateId: number,
    actorId: number,
  ): Promise<boolean> {
    const order = await tx.order.findUnique({
      where: { idEst: estimateId },
      include: {
        status: true,
        estimate: {
          select: {
            idUser: true,
            installationJob: { select: { status: true } },
          },
        },
      },
    });
    if (!order || order.status.name !== 'Awaiting release') return false;

    const schedule = await getPaymentSchedule(tx, estimateId);
    if (!schedule?.canRelease) return false;

    const preparing = await tx.orderStatus.findUnique({
      where: { name: 'Preparing for pickup' },
    });
    if (!preparing) {
      throw new Error('Order status "Preparing for pickup" is not seeded.');
    }

    const installationActive = Boolean(
      order.estimate.installationJob &&
        order.estimate.installationJob.status !== InstallationJobStatus.CANCELED,
    );
    const changedAt = new Date();
    await tx.order.update({
      where: { id: order.id },
      data: {
        statusId: preparing.id,
        updateStatus: changedAt,
        fulfillmentMethod: installationActive
          ? OrderFulfillmentMethod.INSTALLATION_DELIVERY
          : OrderFulfillmentMethod.UNDECIDED,
        fulfillmentSelectedAt: installationActive ? changedAt : null,
        pickupCompletedAt: null,
      },
    });
    await tx.eventLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'Order',
        entityId: order.id,
        userId: actorId,
        message: `Order status changed automatically: "Awaiting release" -> "Preparing for pickup" after the release installment was covered.`,
      },
    });
    await this.notifications.createAndSend(
      {
        recipientId: order.estimate.idUser,
        message: `The status of your order #${order.number} has changed to "Preparing for pickup".`,
        actionUrl: `/orders/${order.id}`,
        actionLabel: 'Open order',
        dedupeKey: `order:${order.id}:status:${preparing.id}:${changedAt.toISOString()}`,
      },
      tx,
    );
    return true;
  }

  private async ensurePaidPaymentEffects(
    tx: Prisma.TransactionClient,
    payment: PaymentWithEstimate,
  ): Promise<boolean> {
    if (payment.type === PaymentType.INSTALLMENT) {
      const schedule = await getPaymentSchedule(tx, payment.idEst);
      const row = schedule?.rows.find(row => row.sequence === payment.sequence);
      if (row && (Number(row.balance) > 0 || row.status === 'REVIEW')) return false;
      if (!row && !paymentIsCovered(payment)) return false;
    } else if (!paymentIsCovered(payment)) return false;
    let changed = false;
    const discount = estimateDiscountConfig(payment.estimate.manualDiscount);
    if (discount && !discount.lockedAt) {
      if (!discount.checkoutAllocations) throw new Error('Missing estimate discount checkout allocation.');
      if (discount.materialDiscountBasis === 'BEFORE_TAX' && discount.checkoutMaterialNetDiscount == null) throw new Error('Missing pre-tax material discount checkout amount.');
      const lockedDiscount = {
        ...discount,
        lockedAt: (payment.paidAt ?? new Date()).toISOString(),
        allocations: discount.checkoutAllocations,
        ...(discount.checkoutMaterialNetDiscount != null ? { materialNetDiscount: discount.checkoutMaterialNetDiscount } : {}),
      };
      await tx.estimate.update({ where: { id: payment.idEst }, data: { manualDiscount: lockedDiscount } });
      payment.estimate.manualDiscount = lockedDiscount;
      changed = true;
    }
    if ((payment.type === PaymentType.MATERIAL || payment.type === PaymentType.INSTALLMENT || payment.type === PaymentType.INSTALLATION_DEPOSIT) && payment.estimate.promotionExpiresAt && !payment.estimate.promotionLockedAt) {
      const pieces = await tx.piece.findMany({where:{idEst:payment.idEst},select:{promotionSnapshot:true}});
      const terms = [...new Map(promotionTerms(pieces.map(p => p.promotionSnapshot)).map(p => [`${p.id}:${p.version}`, p])).values()];
      await tx.estimate.update({where:{id:payment.idEst},data:{promotionLockedAt:payment.paidAt ?? new Date(),promotionContext:terms as unknown as Prisma.InputJsonValue}});
      changed = true;
    }

    if (payment.type === PaymentType.MATERIAL || payment.type === PaymentType.INSTALLMENT) {
      changed =
        (await this.ensureOrderForInitialPayment(tx, payment)) || changed;
    }

    changed =
      (await this.installationWorkflow.markPaymentPaid(tx, payment)) || changed;

    const advancedToPreparing = await this.advanceAwaitingReleaseOrder(
      tx,
      payment.idEst,
      payment.recordedById ?? payment.estimate.idUser,
    );
    changed = advancedToPreparing || changed;

    if (payment.type === PaymentType.INSTALLMENT) {
      changed =
        (await refreshScheduledInstallation(tx, payment.idEst)) || changed;

      // Si RELEASE llevo automaticamente la orden a Preparing for pickup,
      // conserva el mismo aviso de la proxima cuota que el cambio manual.
      if (advancedToPreparing) {
        const orderAfterRelease = await tx.order.findUnique({
          where: { idEst: payment.idEst },
          select: {
            id: true,
            number: true,
            estimate: {
              select: {
                idUser: true,
                installationJob: { select: { status: true } },
              },
            },
          },
        });
        if (
          orderAfterRelease?.estimate.installationJob?.status ===
          InstallationJobStatus.INSTALLATION_PAYMENT_PENDING
        ) {
          await this.notifications.createAndSend(
            {
              recipientId: orderAfterRelease.estimate.idUser,
              message: `The next project installment is due for Order #${orderAfterRelease.number}.`,
              actionUrl: `/orders/${orderAfterRelease.id}`,
              actionLabel: 'Open payment',
              dedupeKey: `order:${orderAfterRelease.id}:installation-balance-due`,
            },
            tx,
          );
        }
      }
    }
    await this.notifyPaymentConfirmed(tx, payment);

    return changed;
  }

  private paymentNotificationCopy(type: PaymentType, sequence: number) {
    switch (type) {
      case PaymentType.INSTALLMENT:
        return { label: `Project installment #${sequence}`, adminNextStep: 'Open payment schedule' };
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
      case PaymentType.DELIVERY:
        return {
          label: `Delivery #${sequence}`,
          adminNextStep: 'Schedule delivery',
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
    const pendingReview = !order && payment.estimate.status.name === PENDING_ORDER_REVIEW &&
      (payment.type === PaymentType.MATERIAL || (payment.type === PaymentType.INSTALLMENT && payment.sequence === 1));
    const actionUrl = pendingReview ? `/estimates/${payment.idEst}/edit` : order
      ? `/orders/${order.id}`
      : payment.installationJobId
        ? `/installations/${payment.installationJobId}`
        : `/estimates/${payment.idEst}`;
    const payer = payment.payerName?.trim();
    const payerSuffix = payer ? ` from ${payer}` : '';

    await this.notifications.createAndSendToRoles(
      ['admin'],
      {
        message: `${copy.label} confirmed${payerSuffix} for Estimate #${payment.estimate.number}.${pendingReview ? " Pending order review." : ""}`,
        actionUrl,
        actionLabel: pendingReview ? 'Review order' : copy.adminNextStep,
        dedupeKey: `payment:${payment.id}:paid:admin`,
      },
      {
        db: tx,
      },
    );

    // El pago se comunica a administración; el dueño recibe solo el aviso de orden creada.
  }

  private async processPaidCheckoutSession(
    tx: Prisma.TransactionClient,
    session: Stripe.Checkout.Session,
  ): Promise<boolean> {
    if (!this.isCompletedCheckout(session)) return false;

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    // Una sesión puede contener varias cuotas del mismo estimate. Se confirman juntas.
    await tx.$queryRaw`SELECT id FROM Estimate WHERE id = (SELECT idEst FROM payments WHERE stripeSessionId = ${session.id} LIMIT 1) FOR UPDATE`;
    const payments = await tx.payment.findMany({
      where: { stripeSessionId: session.id },
      include: {
        estimate: { include: { order: true, installationJob: true, status: true, user: { include: { role: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    if (!payments.length) return false;
    // Cada concepto conserva su recibo y asignación, aunque comparta el checkout.
    if (new Set(payments.map(paymentSelectionKey)).size !== payments.length) throw new Error('Checkout contains duplicate payment items.');
    if (payments.some(p => p.idEst !== payments[0].idEst)) throw new Error('Checkout contains payments from different estimates.');
    const recordedAmountCents = payments.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0);
    if (session.amount_total == null || session.amount_total !== recordedAmountCents ||
        payments.some(p => p.currency.toLowerCase() !== String(session.currency ?? '').toLowerCase())) {
      throw new Error(`Paid checkout amount mismatch for Payment #${payments[0].id}.`);
    }
    const charge = paymentIntentId ? await this.successfulCharge(paymentIntentId) : null;
    if (recordedAmountCents > 0 && (!charge || charge.amount_captured !== recordedAmountCents || charge.currency !== session.currency)) {
      throw new Error('Stripe capture does not match the recorded checkout.');
    }
    const method = charge ? stripePaymentMethod(charge) : { paymentMethod: PaymentMethod.OTHER, paymentMethodLabel: 'No payment required' };
    const paidAt = charge ? new Date(charge.created * 1000) : new Date();
    for (const payment of payments) {
      if ([PaymentStatus.PAID, PaymentStatus.REFUNDED].includes(payment.status as any)) continue;
      await tx.payment.update({ where: { id: payment.id }, data: {
        status: PaymentStatus.PAID,
        ...method,
        paidAt,
        payerName: session.customer_details?.name ?? payment.payerName,
        payerEmail: session.customer_details?.email ?? payment.payerEmail,
        payerPhone: session.customer_details?.phone ?? payment.payerPhone,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : payment.stripeCustomerId,
        stripePaymentIntentId: paymentIntentId ?? payment.stripePaymentIntentId,
      } });
    }
    if (charge) {
      for (const payment of payments) {
        const confirmed = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        await recordStripeReceipt(tx, confirmed, charge, session.id);
      }
      await this.applyStripeRefunds(tx, charge);
    }
    // Aplica los efectos cuando todos los conceptos ya están pagados, con datos actuales.
    for (const payment of payments) {
      const confirmed = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: {
        estimate: { include: { order: true, installationJob: true, status: true, user: { include: { role: true } } } },
      } });
      await this.ensurePaidPaymentEffects(tx, confirmed);
    }
    return true;
  }

  private async reconcilePaidPaymentEffects(): Promise<void> {
    const candidates = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PAID,
        estimate: { status: { name: { not: PENDING_ORDER_REVIEW } } },
        OR: [
          { type: PaymentType.INSTALLMENT, sequence: 1, estimate: { order: null } },
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
          {
            type: PaymentType.DELIVERY,
            delivery: {
              is: { status: DeliveryStatus.PAYMENT_DUE },
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
          await tx.$queryRaw`SELECT id FROM Estimate WHERE id = (SELECT idEst FROM payments WHERE id = ${candidate.id}) FOR UPDATE`;
          const payment = await tx.payment.findUnique({
            where: { id: candidate.id },
            include: {
              estimate: {
                include: {
                  order: true,
                  installationJob: true,
                  status: true,
                  user: { include: { role: true } },
                },
              },
            },
          });
          if (!payment || !paymentIsCovered(payment)) return false;

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
    stripeSessionId: string,
    finalStatus: PaymentStatus,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.payment.updateMany({
      where: {
        status: { notIn: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
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

      const reconciledSessions = new Set<string>();
      for (const payment of pendingPayments) {
        const stripeSessionId = payment.stripeSessionId;
        if (!stripeSessionId || reconciledSessions.has(stripeSessionId)) continue;
        reconciledSessions.add(stripeSessionId);

        try {
          const session =
            await this.stripe.checkout.sessions.retrieve(stripeSessionId);
          if (this.isCompletedCheckout(session)) {
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

      // Recupera notificaciones perdidas de métodos antiguos y reembolsos todavía pendientes.
      const legacy = await this.prisma.payment.findMany({ where: {
        status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] }, stripeSessionId: { not: null },
        stripeMethodType: null, amount: { gt: 0 },
      }, select: { stripeSessionId: true }, orderBy: { id: 'asc' }, take: 20 });
      for (const sessionId of new Set(legacy.map(p => p.stripeSessionId!))) {
        try {
          const session = await this.stripe.checkout.sessions.retrieve(sessionId);
          await this.prisma.$transaction(tx => this.processPaidCheckoutSession(tx, session), { timeout: 30000 });
        } catch (error) { this.logger.error(`Unable to reconcile historic checkout ${sessionId}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const pendingRefunds = await this.prisma.paymentRefund.findMany({ where: { status: { in: ['pending', 'requires_action'] } },
        orderBy: { updatedAt: 'asc' }, take: 20, select: { stripeChargeId: true } });
      for (const chargeId of new Set(pendingRefunds.map(r => r.stripeChargeId))) {
        try { await this.synchronizeStripeCharge(chargeId); }
        catch (error) { this.logger.error(`Unable to reconcile pending refund for ${chargeId}: ${error instanceof Error ? error.message : String(error)}`); }
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
            deliveries: {
              where: { status: DeliveryStatus.PAYMENT_DUE },
              orderBy: { sequence: 'asc' },
            },
          },
        },
        installationJob: { select: { id: true, status: true } },
        payments: true,
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
      deliveries: Array<{ sequence: number }>;
    } | null;
    installationJob: {
      status: InstallationJobStatus;
    } | null;
  }): { type: PaymentType; sequence?: number } | null {
    const job =
      estimate.installationJob?.status === InstallationJobStatus.CANCELED
        ? null
        : estimate.installationJob;

    if (!job && !estimate.order && estimate.status.name === 'Active') {
      return { type: PaymentType.MATERIAL };
    }

    if (job?.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) {
      return { type: PaymentType.INSTALLATION_DEPOSIT };
    }
    if (job?.status === InstallationJobStatus.PERMIT_PAYMENT_PENDING) {
      return { type: PaymentType.PERMIT };
    }
    if (job?.status === InstallationJobStatus.MATERIAL_PAYMENT_PENDING) {
      return { type: PaymentType.MATERIAL };
    }
    if (job?.status === InstallationJobStatus.INSTALLATION_PAYMENT_PENDING) {
      return { type: PaymentType.INSTALLATION };
    }

    const delivery = estimate.order?.deliveries[0];
    if (delivery) {
      return { type: PaymentType.DELIVERY, sequence: delivery.sequence };
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
    if (type === PaymentType.DELIVERY) return `Delivery #${sequence}`;
    return `Extra charge #${sequence}`;
  }

  private async publicPaymentOptions(
    tx: Prisma.TransactionClient,
    estimate: Awaited<ReturnType<PaymentsService['findPublicEstimateForPayment']>>['estimate'],
    schedule: Awaited<ReturnType<typeof getPaymentSchedule>>,
  ) {
    const requests = new Map<string, { type: PaymentType; sequence?: number; advanceOnly: boolean }>();
    const add = (type: PaymentType, sequence?: number, advanceOnly = false) => {
      const item = { type, sequence, advanceOnly };
      const existing = estimate.payments.find(p => p.type === type && p.sequence === sequence);
      if (existing?.refundReviewPending || (type !== PaymentType.INSTALLMENT && paymentIsCovered(existing))) return;
      if (!requests.has(paymentSelectionKey(item))) requests.set(paymentSelectionKey(item), item);
    };
    const depositDue = estimate.installationJob?.status === 'DEPOSIT_PAYMENT_PENDING';
    for (const payment of estimate.payments) {
      if (payment.type !== PaymentType.INSTALLMENT && hasRefundHistory(payment) &&
          remainingRefundBalance(payment).gt(0) &&
          (!schedule || [PaymentType.DELIVERY, PaymentType.EXTRA].includes(payment.type as any))) {
        add(payment.type, payment.sequence);
      }
    }
    if (depositDue) add(PaymentType.INSTALLATION_DEPOSIT);
    else if (schedule) {
      for (const row of schedule.rows) {
        if (row.status === 'DUE' || row.sequence === schedule.next?.sequence) add(PaymentType.INSTALLMENT, row.sequence);
      }
    } else {
      const next = this.resolveNextPaymentRequest(estimate);
      if (next) add(next.type, next.sequence);
    }
    for (const delivery of estimate.order?.deliveries ?? []) {
      if (!delivery.status || delivery.status === DeliveryStatus.PAYMENT_DUE) add(PaymentType.DELIVERY, delivery.sequence);
    }
    for (const extra of estimate.order?.extraCharges ?? []) {
      if (!extra.status || extra.status === OrderExtraChargeStatus.PAYMENT_DUE) add(PaymentType.EXTRA, extra.sequence);
    }
    if (!depositDue) {
      for (const sequence of schedule?.fullBalance?.sequences ?? []) add(PaymentType.INSTALLMENT, sequence, true);
    }
    const owner = { id: estimate.idUser, role: { name: 'dealer' as const } } satisfies AuthUser;
    const payments: Array<{
      type: PaymentType; sequence: number; title: string; description: string;
      baseAmount: string; surchargePercent: string; surchargeAmount: string; totalAmount: string;
      checkoutStarted: boolean; requiresCityFeeAcceptance: boolean; cityFeeAmount?: string;
      requiresTerms: boolean; terms: string | null; advanceOnly: boolean;
    }> = [];
    for (const request of requests.values()) {
      let context: Awaited<ReturnType<InstallationWorkflowService['getPaymentContext']>>;
      try {
        context = await this.installationWorkflow.getPaymentContext(estimate.id, request.type, request.sequence,
          undefined, owner, tx, { preview: true, allowAdvance: request.advanceOnly });
      } catch (error) {
        // Un cargo aún no aprobado o bajo revisión no debe ocultar los otros cargos disponibles.
        if (error instanceof BadRequestException || error instanceof ConflictException) continue;
        throw error;
      }
      const existing = estimate.payments.find(p => p.type === request.type && p.sequence === context.paymentSequence);
      // Los cobros antiguos de instalación resuelven su secuencia desde la versión de la cotización.
      if ((request.type !== PaymentType.INSTALLMENT && paymentIsCovered(existing)) ||
          payments.some(p => p.type === request.type && p.sequence === context.paymentSequence)) continue;
      payments.push({
        type: request.type, sequence: context.paymentSequence, advanceOnly: request.advanceOnly,
        title: request.type === PaymentType.INSTALLMENT
          ? schedule!.rows.find(row => row.sequence === context.paymentSequence)!.title
          : this.publicPaymentTitle(request.type, context.paymentSequence),
        description: context.description,
        baseAmount: context.baseAmount.toFixed(2), surchargePercent: context.surchargePercent.toFixed(4),
        surchargeAmount: context.surchargeAmount.toFixed(2), totalAmount: context.totalAmount.toFixed(2),
        checkoutStarted: Boolean(existing?.status === PaymentStatus.PENDING && existing.stripeSessionId),
        requiresCityFeeAcceptance: Boolean(context.requiresCityFeeAcceptance), cityFeeAmount: context.cityFeeAmount,
        requiresTerms: request.type === PaymentType.INSTALLATION_DEPOSIT && !context.job?.depositTermsAcceptedAt,
        terms: request.type === PaymentType.INSTALLATION_DEPOSIT ? context.job?.depositTermsSnapshot || INSTALLATION_DEPOSIT_TERMS : null,
      });
    }
    const total = payments.reduce((sum, p) => sum.add(p.baseAmount), new Prisma.Decimal(0));
    // Solo se ofrece liquidación total si incluye todo el saldo conocido y aprobado.
    const fullBalance = !depositDue && schedule &&
      (schedule.fullBalance || Number(schedule.balance) === 0) &&
      !estimate.payments.some(p => p.refundReviewPending) && payments.length === requests.size && total.gt(0)
      ? { amount: total.toFixed(2), items: payments.map(({ type, sequence }) => ({ type, sequence })) }
      : null;
    return { payments, fullBalance };
  }

  async getPublicPaymentContext(token: string) {
    return this.prisma.$transaction(async (tx) => {
      const { estimate } = await this.findPublicEstimateForPayment(token, tx);
      if (estimate.dealerModeSnapshot !== DealerMode.INTERNAL) {
        return { enabled: false, status: 'not_applicable', payment: null } as UnavailablePublicPaymentContext;
      }
      if (promotionExpired(estimate)) return { enabled: true, status: 'expired', payment: null } as UnavailablePublicPaymentContext;
      const agreement = await getAgreementPaymentRequirement(tx, estimate.id, token);
      const schedule = await getPaymentSchedule(tx, estimate.id);
      const options = await this.publicPaymentOptions(tx, estimate, schedule);
      const payment = options.payments.find(p => !p.advanceOnly) ?? options.payments[0] ?? null;
      const checkoutRows = estimate.payments.filter(p => p.status === PaymentStatus.PENDING && p.stripeSessionId);
      const checkouts = [...new Set(checkoutRows.map(p => p.stripeSessionId))].map(sessionId => {
        const group = checkoutRows.filter(p => p.stripeSessionId === sessionId);
        const total = (field: 'baseAmount' | 'surchargeAmount' | 'amount') => group.reduce(
          (sum, p) => sum.add(p[field]), new Prisma.Decimal(0),
        ).toFixed(2);
        return { items: group.map(({ type, sequence }) => ({ type, sequence })), baseAmount: total('baseAmount'),
          surchargePercent: group[0].surchargePercent.toFixed(4), surchargeAmount: total('surchargeAmount'), totalAmount: total('amount') };
      });
      return {
        enabled: true as const,
        status: payment ? payment.advanceOnly ? 'available' as const : 'due' as const
          : estimate.payments.some(p => p.refundReviewPending) ? 'review' as const : 'complete' as const,
        agreement, schedule, ...options, checkouts,
        installmentCheckouts: checkouts.filter(c => c.items.every(p => p.type === PaymentType.INSTALLMENT))
          .map(({ items, ...rest }) => ({ ...rest, sequences: items.map(p => p.sequence) })),
        promotionExpiresAt: estimate.promotionExpiresAt, expiresAt: estimate.expiresAt, promotionLockedAt: estimate.promotionLockedAt,
        payment,
      };
    });
  }

  async createCheckoutSessionForPublicToken(params: {
    token: string;
    type?: PaymentType;
    sequence?: number;
    items?: PaymentSelection[];
    installationDepositTermsAccepted?: boolean;
    cityFeeAccepted?: boolean;
    agreementId?: string;
    sequences?: number[];
    payFullBalance?: boolean;
    expectedBalance?: number;
  }) {
    if ((params.items !== undefined && (params.type !== undefined || params.sequence !== undefined || params.sequences !== undefined || params.payFullBalance)) ||
        (params.payFullBalance && (params.type !== undefined || params.sequence !== undefined || params.sequences !== undefined))) {
      throw new BadRequestException('Choose either payment items or the full balance.');
    }
    if (params.sequence !== undefined && params.type === undefined) throw new BadRequestException('Payment type is required with a sequence.');
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
      type: params.type ?? (params.sequences || params.payFullBalance ? PaymentType.INSTALLMENT : publicContext.payment.type),
      sequence: params.items || params.sequences || params.payFullBalance ? undefined
        : params.sequence ?? (params.type === undefined ? publicContext.payment.sequence : undefined),
      items: params.items,
      sequences: params.sequences,
      payFullBalance: params.payFullBalance,
      expectedBalance: params.expectedBalance,
      installationDepositTermsAccepted: params.installationDepositTermsAccepted,
      cityFeeAccepted: params.cityFeeAccepted,
      user: { id: owner.idUser, role: { name: 'dealer' } },
      publicToken: params.token,
      publicAgreementId: params.agreementId,
    });
  }

  private async selectedPaymentContexts(
    tx: Prisma.TransactionClient,
    params: { estimateId: number; type: PaymentType; sequence?: number; sequences?: number[]; items?: PaymentSelection[]; publicToken?: string; payFullBalance?: boolean; expectedBalance?: number; installationDepositTermsAccepted?: boolean },
    user: AuthUser,
    preview = false,
  ) {
    if (params.sequences !== undefined && (
      params.type !== PaymentType.INSTALLMENT || params.sequence !== undefined ||
      !Array.isArray(params.sequences) || !params.sequences.length || params.sequences.length > 50 ||
      params.sequences.some(s => !Number.isSafeInteger(s) || s < 1) ||
      new Set(params.sequences).size !== params.sequences.length
    )) throw new BadRequestException('Select one or more distinct installments that are due.');
    const sequences = params.sequences ? [...params.sequences].sort((a, b) => a - b) : [params.sequence];
    let selections: Array<{ type: PaymentType; sequence?: number }> = sequences.map(sequence => ({ type: params.type, sequence }));
    if (params.items !== undefined) {
      if (!params.publicToken || params.payFullBalance || params.sequence !== undefined || params.sequences !== undefined ||
          !Array.isArray(params.items) || !params.items.length || params.items.length > 50 ||
          params.items.some(p => !p || !Object.values(PaymentType).includes(p.type) || !Number.isSafeInteger(p.sequence) || p.sequence < 1) ||
          new Set(params.items.map(paymentSelectionKey)).size !== params.items.length ||
          typeof params.expectedBalance !== 'number' || !Number.isFinite(params.expectedBalance) || params.expectedBalance < 0 ||
          new Prisma.Decimal(params.expectedBalance).decimalPlaces() > 2) {
        throw new BadRequestException('Select distinct payment items and review their total before payment.');
      }
      const { estimate } = await this.findPublicEstimateForPayment(params.publicToken, tx);
      if (estimate.id !== params.estimateId || estimate.idUser !== user.id || estimate.dealerModeSnapshot !== DealerMode.INTERNAL) throw new NotFoundException('Customer payment link not found.');
      const options = await this.publicPaymentOptions(tx, estimate, await getPaymentSchedule(tx, estimate.id));
      if (params.items.some(item => !options.payments.some(p => !p.advanceOnly && paymentSelectionKey(p) === paymentSelectionKey(item)))) {
        throw new ConflictException('A selected payment is no longer available. Refresh the payment list.');
      }
      selections = [...params.items];
    }
    if (params.payFullBalance) {
      if (params.type !== PaymentType.INSTALLMENT || params.sequence !== undefined || params.sequences !== undefined ||
        typeof params.expectedBalance !== 'number' || !Number.isFinite(params.expectedBalance) ||
        params.expectedBalance <= 0 || new Prisma.Decimal(params.expectedBalance).decimalPlaces() > 2) {
        throw new BadRequestException('Review the full project balance before payment.');
      }
      // Obtiene y valida el saldo bajo el mismo bloqueo que protege los cobros.
      await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${params.estimateId} FOR UPDATE`;
      const owner = await tx.estimate.findUnique({ where: { id: params.estimateId }, select: { idUser: true } });
      if (!owner || owner.idUser !== user.id) throw new NotFoundException('Estimate not found.');
      const schedule = await getPaymentSchedule(tx, params.estimateId);
      let fullBalance: { amount: string; items: PaymentSelection[] } | null = schedule?.fullBalance
        ? { amount: schedule.fullBalance.amount, items: schedule.fullBalance.sequences.map(sequence => ({ type: PaymentType.INSTALLMENT, sequence })) } : null;
      if (params.publicToken) {
        const { estimate } = await this.findPublicEstimateForPayment(params.publicToken, tx);
        if (estimate.id !== params.estimateId || estimate.idUser !== user.id || estimate.dealerModeSnapshot !== DealerMode.INTERNAL) throw new NotFoundException('Customer payment link not found.');
        fullBalance = (await this.publicPaymentOptions(tx, estimate, schedule)).fullBalance;
      }
      if (!fullBalance) throw new ConflictException('The full project balance is not available. Refresh the payment schedule.');
      if (!new Prisma.Decimal(params.expectedBalance).eq(fullBalance.amount)) {
        throw new ConflictException('The project balance changed. Refresh and review the updated amount before payment.');
      }
      selections = fullBalance.items;
    }
    const contexts: Awaited<ReturnType<InstallationWorkflowService['getPaymentContext']>>[] = [];
    // Orden estable para repartir recargos, registrar recibos y reanudar la misma selección.
    selections.sort((a, b) => a.type.localeCompare(b.type) || (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const item of selections) {
      const context = await this.installationWorkflow.getPaymentContext(
        params.estimateId, item.type, item.sequence, params.installationDepositTermsAccepted, user, tx,
        { preview, ...(params.payFullBalance ? { allowAdvance: true } : {}) },
      );
      contexts.push({ ...context, type: item.type });
    }
    if (params.items && !contexts.reduce((sum, c) => sum.add(c.baseAmount.toString()), new Prisma.Decimal(0)).eq(params.expectedBalance!)) {
      throw new ConflictException('The selected balance changed. Refresh and review the updated amount before payment.');
    }
    // Calcula el recargo una sola vez sobre el total y distribuye los centavos sin perderlos.
    if (contexts.length > 1) {
      let base = new Prisma.Decimal(0);
      let fee = new Prisma.Decimal(0);
      for (const context of contexts) {
        base = base.add(context.baseAmount.toFixed(2));
        const cumulativeFee = base.mul(context.surchargePercent.toString()).div(100).toDecimalPlaces(2);
        const allocatedFee = cumulativeFee.minus(fee);
        context.surchargeAmount = new Decimal(allocatedFee.toFixed(2));
        context.totalAmount = context.baseAmount.add(context.surchargeAmount);
        fee = cumulativeFee;
      }
    }
    // Guarda el plan vigente antes del primer cobro/checkout, dentro de su misma transacción.
    if (!preview && contexts[0]) await refreshDraftEarningsPlan(tx, contexts[0].estimate, { freeze: true });
    return contexts;
  }

  private async resumeOrCloseSelectedCheckouts(
    tx: Prisma.TransactionClient,
    existing: Array<{ stripeSessionId: string | null } | null>,
    contexts: Awaited<ReturnType<PaymentsService['selectedPaymentContexts']>>,
    refreshUrl: string,
  ): Promise<{ url: string } | null> {
    const sessions = [...new Set(existing.map(p => p?.stripeSessionId).filter((id): id is string => Boolean(id)))];
    for (const sessionId of sessions) {
      let session: Stripe.Checkout.Session;
      try {
        session = await this.stripe.checkout.sessions.retrieve(sessionId);
      } catch (error: unknown) {
        if ((error as { code?: string })?.code !== 'resource_missing') throw error;
        await this.closeUnpaidCheckoutSession(sessionId, PaymentStatus.EXPIRED, tx);
        continue;
      }
      if (this.isCompletedCheckout(session)) {
        await this.processPaidCheckoutSession(tx, session);
        // La selección puede haber cambiado: refresca los saldos confirmados antes de otro cobro.
        return { url: refreshUrl };
      }
      if (session.status === 'complete') throw new ConflictException('Checkout completed, but payment confirmation is pending.');
      const group = await tx.payment.findMany({ where: { stripeSessionId: sessionId } });
      const matchesSelection = group.length === contexts.length && group.every(p =>
        p.idEst === contexts[0].estimate.id && p.status === PaymentStatus.PENDING &&
        contexts.some(c => c.type === p.type && c.paymentSequence === p.sequence && c.baseAmount.eq(p.baseAmount.toString())));
      if (session.status === 'open' && matchesSelection) {
        if (!session.url) throw new BadRequestException('Stripe session has no checkout URL.');
        return { url: session.url };
      }
      if (session.status === 'open') {
        try {
          await this.stripe.checkout.sessions.expire(sessionId);
        } catch (error) {
          const latest = await this.stripe.checkout.sessions.retrieve(sessionId);
          if (this.isCompletedCheckout(latest)) {
            await this.processPaidCheckoutSession(tx, latest);
            return { url: refreshUrl };
          }
          if (latest.status !== 'expired') throw error;
        }
      } else if (session.status !== 'expired') {
        throw new ConflictException('The previous checkout is still processing. Refresh before trying again.');
      }
      await this.closeUnpaidCheckoutSession(sessionId, PaymentStatus.CANCELED, tx);
    }
    return null;
  }

  async createCheckoutSessionForEstimate(params: {
    estimateId: number;
    type?: PaymentType;
    sequence?: number;
    sequences?: number[];
    items?: PaymentSelection[];
    payFullBalance?: boolean;
    expectedBalance?: number;
    installationDepositTermsAccepted?: boolean;
    cityFeeAccepted?: boolean;
    materialAccepted?: boolean;
    user: AuthUser;
    publicToken?: string;
    publicAgreementId?: string;
  }) {
    const type = params.type ?? PaymentType.MATERIAL;

    return this.prisma.$transaction(async (tx) => {
      if (params.publicToken) {
        // Evita leer un estado anterior a la exención antes de bloquear Estimate.
        await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${params.estimateId} FOR UPDATE`;
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

      const contexts = await this.selectedPaymentContexts(tx, { ...params, type }, params.user);
      const context = contexts[0];
      if (
        context.estimate.dealerModeSnapshot === DealerMode.INTERNAL &&
        !params.publicToken
      ) {
        throw new ConflictException(
          'Internal dealer charges must be paid by the final customer from the public share link.',
        );
      }
      const requiresMaterialAcceptance =
        contexts.some(c => c.type === PaymentType.MATERIAL || (c.type === PaymentType.INSTALLMENT && c.paymentSequence === 1)) &&
        context.estimate.user.role.name === 'client';
      if (requiresMaterialAcceptance && params.materialAccepted !== true) {
        throw new BadRequestException(
          'Review and accept the material details in your estimate before payment.',
        );
      }
      for (const selected of contexts) await this.acceptCityFee(tx, selected, params.cityFeeAccepted, params.estimateId, params.user.id);
      const materialAcceptance = requiresMaterialAcceptance
        ? {
            materialAcceptanceText: MATERIAL_ACCEPTANCE_TEXT,
            materialAcceptedAt: new Date(),
          }
        : {};
      // El servidor exige la firma aunque se omita agreementId. El depósito
      // conserva su propia aceptación de términos y no exige contrato firmado.
      if (params.publicToken && contexts.some(c => c.type !== PaymentType.INSTALLATION_DEPOSIT)) {
        await requireSignedAgreementForPayment(
          tx, params.estimateId, params.publicToken, params.publicAgreementId,
        );
      }
      const firstType = context.type;
      const frontendUrl = this.getFrontendUrl();
      const checkoutRef = randomUUID();
      const query = params.publicToken
        ? `token=${encodeURIComponent(params.publicToken)}&type=${firstType}&sequence=${context.paymentSequence}${params.publicAgreementId ? `&agreementId=${encodeURIComponent(params.publicAgreementId)}` : ''}`
        : `estimateId=${params.estimateId}&type=${firstType}&sequence=${context.paymentSequence}`;
      const successUrl = params.publicToken
        ? `${frontendUrl}/public/checkout/success?${query}`
        : `${frontendUrl}/checkout/success?${query}`;
      const cancelUrl = params.publicToken
        ? `${frontendUrl}/public/checkout/cancel?${query}&checkoutRef=${checkoutRef}`
        : `${frontendUrl}/checkout/cancel?${query}&checkoutRef=${checkoutRef}`;
      const payer = this.getPayerSnapshot(context.estimate);

      const existingPayments = [] as Array<Awaited<ReturnType<typeof tx.payment.findUnique>>>;
      for (const selected of contexts) {
        const existing = await tx.payment.findUnique({ where: { idEst_type_sequence: {
          idEst: params.estimateId, type: selected.type, sequence: selected.paymentSequence,
        } } });
        if (existing?.refundReviewPending) throw new ConflictException('Review this refund before collecting another payment.');
        if (existing && [PaymentStatus.PAID, PaymentStatus.REFUNDED].includes(existing.status as any) && !hasRefundHistory(existing)) {
          throw new ConflictException(`${type} payment is already paid or requires administrative reconciliation.`);
        }
        existingPayments.push(existing);
      }
      if (type === PaymentType.INSTALLMENT || params.publicToken) {
        const refreshUrl = params.publicToken
          ? params.publicAgreementId
            ? `${frontendUrl}/public/estimates/${encodeURIComponent(params.publicToken)}/agreements/${encodeURIComponent(params.publicAgreementId)}`
            : `${frontendUrl}/public/payments/${encodeURIComponent(params.publicToken)}`
          : context.estimate.order ? `${frontendUrl}/orders/${context.estimate.order.id}` : `${frontendUrl}/estimates/${params.estimateId}/edit#estimate-payment`;
        const resumed = await this.resumeOrCloseSelectedCheckouts(tx, existingPayments, contexts, refreshUrl);
        if (resumed) return resumed;
      }
      const existingPayment = type === PaymentType.INSTALLMENT || params.publicToken ? null : existingPayments[0];
      if (existingPayment?.stripeSessionId) {
        try {
          const existingSession = await this.stripe.checkout.sessions.retrieve(
            existingPayment.stripeSessionId,
          );
          if (this.isCompletedCheckout(existingSession)) {
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
            // Conserva la fecha original al reanudar la misma sesión aceptada.
            if (
              requiresMaterialAcceptance &&
              (!existingPayment.materialAcceptedAt ||
                existingPayment.materialAcceptanceText !== MATERIAL_ACCEPTANCE_TEXT)
            ) {
              await tx.payment.update({
                where: { id: existingPayment.id },
                data: materialAcceptance,
              });
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

      if (existingPayment?.status === PaymentStatus.PAID && !hasRefundHistory(existingPayment)) {
        throw new ConflictException(`${type} payment is already paid.`);
      }

      const payments = [] as Array<{ id: number }>;
      for (const context of contexts) {
        const payment = await tx.payment.upsert({
          where: {
            idEst_type_sequence: {
              idEst: params.estimateId,
              type: context.type,
              sequence: context.paymentSequence,
            },
          },
          create: {
            idEst: params.estimateId,
            type: context.type,
            sequence: context.paymentSequence,
            installationJobId: context.job?.id ?? null,
            extraChargeId: context.extraCharge?.id ?? null,
            deliveryId: context.delivery?.id ?? null,
            userId: context.estimate.idUser,
            ...payer,
            ...(requiresMaterialAcceptance && context.paymentSequence === 1 ? materialAcceptance : {}),
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
            paymentMethod: PaymentMethod.OTHER,
            paymentMethodLabel: 'Stripe — awaiting confirmation',
            stripeMethodType: null,
            stripeFundingSourceGroup: null,
          },
          update: {
            installationJobId: context.job?.id ?? null,
            extraChargeId: context.extraCharge?.id ?? null,
            deliveryId: context.delivery?.id ?? null,
            userId: context.estimate.idUser,
            ...payer,
            ...(requiresMaterialAcceptance && context.paymentSequence === 1 ? materialAcceptance : {}),
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
            paymentMethod: PaymentMethod.OTHER,
            paymentMethodLabel: 'Stripe — awaiting confirmation',
            stripeMethodType: null,
            stripeFundingSourceGroup: null,
            paidAt: null,
            manualReference: null,
            manualNote: null,
            recordedById: null,
            stripeSessionId: null,
            stripePaymentIntentId: null,
          },
        });

        payments.push(payment);
      }

      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        ui_mode: 'hosted_page',
        expires_at: checkoutPromotionExpiry(context.estimate),
        success_url: successUrl,
        cancel_url: cancelUrl,
        payment_method_types: ['card'],
        line_items: contexts.map(context => {
          const feeDescription = context.surchargeAmount.gt(0)
            ? `Card processing fee: $${context.surchargeAmount.toFixed(2)}.` : '';
          return { quantity: 1, price_data: {
            currency: 'usd',
            unit_amount: Math.round(context.totalAmount.toNumber() * 100),
            product_data: {
              name: context.description,
              description: context.type === PaymentType.INSTALLATION_DEPOSIT
                ? `${context.job?.depositTermsSnapshot || INSTALLATION_DEPOSIT_TERMS}${feeDescription ? ` ${feeDescription}` : ''}`
                : feeDescription || undefined,
            },
          } };
        }),
        metadata: {
          paymentId: String(payments[0].id),
          paymentIds: payments.map(p => p.id).join(','),
          checkoutRef,
          ...(params.payFullBalance ? { paymentScope: 'FULL_PROJECT_BALANCE' } : {}),
          estimateId: String(params.estimateId),
          userId: String(context.estimate.idUser),
          paymentType: contexts.every(c => c.type === firstType) ? firstType : 'MIXED',
          payerType: payer.payerType,
        },
        ...(payer.payerEmail ? { customer_email: payer.payerEmail } : {}),
      });
      if (!session.url) {
        throw new BadRequestException('Stripe session URL not returned.');
      }

      for (const payment of payments) {
        await tx.payment.update({ where: { id: payment.id }, data: { stripeSessionId: session.id } });
      }
      return { url: session.url };
    }, { timeout: 30_000 });
  }

  async cancelCheckoutSessionForEstimate(params: {
    estimateId: number;
    type?: PaymentType;
    sequence?: number;
    checkoutRef?: string;
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
        stripeSessionId,
        PaymentStatus.CANCELED,
      );
      return {
        status: 'canceled' as const,
        orderId: estimate.order?.id ?? null,
      };
    }

    // Una página de cancelación antigua no debe cerrar un checkout más reciente.
    if (params.checkoutRef && session.metadata?.checkoutRef !== params.checkoutRef) {
      return { status: 'canceled' as const, orderId: estimate.order?.id ?? null };
    }
    if (this.isCompletedCheckout(session)) return finalizePaid(session);
    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(stripeSessionId);
      } catch (error) {
        const latest =
          await this.stripe.checkout.sessions.retrieve(stripeSessionId);
        if (this.isCompletedCheckout(latest)) return finalizePaid(latest);
        if (latest.status !== 'expired') throw error;
      }
    } else if (session.status === 'complete') {
      throw new ConflictException(
        'Checkout completed, but payment confirmation is pending.',
      );
    }

    await this.closeUnpaidCheckoutSession(
      stripeSessionId,
      PaymentStatus.CANCELED,
    );
    return { status: 'canceled' as const, orderId: estimate.order?.id ?? null };
  }

  async cancelCheckoutSessionForPublicToken(params: {
    token: string;
    type?: PaymentType;
    sequence?: number;
    checkoutRef?: string;
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
      checkoutRef: params.checkoutRef,
      user: { id: owner.idUser, role: { name: 'dealer' } },
      publicToken: params.token,
    });
    return { status: result.status };
  }

  private async closeStripeCheckoutBeforePaymentChange(
    payment: {
      id: number;
      status: PaymentStatus;
      stripeSessionId: string | null;
    },
    requireConfirmedClosure = false,
    allowRefundRecovery = false,
  ) {
    if (payment.status === PaymentStatus.PAID && !allowRefundRecovery) {
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
      if (stripeError?.code === 'resource_missing' && !requireConfirmedClosure)
        return;
      throw error;
    }

    if (this.isCompletedCheckout(session)) {
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
    if (
      requireConfirmedClosure &&
      session.status !== 'open' &&
      session.status !== 'expired'
    ) {
      throw new ConflictException(
        'The deposit checkout status could not be confirmed. Try again before waiving it.',
      );
    }
    if (session.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(session.id);
      } catch (error) {
        const latest = await this.stripe.checkout.sessions.retrieve(session.id);
        if (this.isCompletedCheckout(latest)) {
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

  async acceptDealerMeasurements(jobId: number, actor: AuthUser) {
    if (!['admin', 'dealer'].includes(actor.role?.name ?? '')) {
      throw new ForbiddenException(
        'Only administrators or the internal dealer who owns the estimate can waive the deposit.',
      );
    }
    const job = await this.installationWorkflow.findJob(jobId, actor);
    this.installationWorkflow.assertDealerMeasurementsCanBeAccepted(job, actor);
    if (job.dealerMeasurementsAcceptedAt) return job;

    for (const payment of job.estimate.payments) {
      if (
        payment.type !== PaymentType.INSTALLATION_DEPOSIT ||
        !payment.stripeSessionId
      )
        continue;
      // Reutiliza el cierre seguro: un pago confirmado o en procesamiento
      // impide continuar. No se elimina ni se modifica un pago realizado.
      await this.closeStripeCheckoutBeforePaymentChange(payment, true);
      await this.closeUnpaidCheckoutSession(
        payment.stripeSessionId,
        PaymentStatus.CANCELED,
      );
    }
    return this.installationWorkflow.acceptDealerMeasurements(jobId, actor);
  }

  async recordManualPayment(params: {
    estimateId: number;
    type: PaymentType;
    sequence?: number;
    sequences?: number[];
    payFullBalance?: boolean;
    expectedBalance?: number;
    method: PaymentMethod;
    fundsVerified: true;
    reference: string;
    note?: string;
    paidAt?: string;
    installationDepositTermsAccepted?: boolean;
    cityFeeAccepted?: boolean;
    actor: AuthUser;
  }) {
    if (params.fundsVerified !== true) {
      throw new BadRequestException(
        'Confirm that the funds are already available before recording a manual payment.',
      );
    }
    if ([PaymentMethod.CARD, PaymentMethod.BANK].includes(params.method as any)) {
      throw new BadRequestException(
        'Card and Stripe bank payments must be confirmed through Stripe. Use ACH or WIRE for a verified manual bank payment.',
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

    const previews = await this.prisma.$transaction(tx => this.selectedPaymentContexts(tx, params, ownerUser, true));
    if (previews.some(c => c.requiresCityFeeAcceptance) && params.cityFeeAccepted !== true) {
      throw new BadRequestException('Confirm customer acceptance of the City Fee adjustment.');
    }
    for (const preview of previews) {
      const existingPayment = await this.prisma.payment.findUnique({ where: { idEst_type_sequence: {
        idEst: params.estimateId, type: params.type, sequence: preview.paymentSequence,
      } } });
      if (existingPayment) {
        await this.closeStripeCheckoutBeforePaymentChange(existingPayment, false, hasRefundHistory(existingPayment) && !existingPayment.refundReviewPending);
        if (existingPayment.stripeSessionId) await this.closeUnpaidCheckoutSession(
          existingPayment.stripeSessionId, PaymentStatus.CANCELED,
        );
      }
    }

    return this.prisma.$transaction(async tx => {
      const contexts = await this.selectedPaymentContexts(tx, params, ownerUser);
      // Verifica todo antes de escribir: ningún concepto puede quedar registrado parcialmente.
      for (const context of contexts) {
        await this.acceptCityFee(tx, context, params.cityFeeAccepted, params.estimateId, params.actor.id, true);
        const current = await tx.payment.findUnique({ where: { idEst_type_sequence: {
          idEst: params.estimateId, type: params.type, sequence: context.paymentSequence,
        } } });
        if (current?.refundReviewPending || (current && [PaymentStatus.PAID, PaymentStatus.REFUNDED].includes(current.status as any) && !hasRefundHistory(current))) throw new ConflictException('This charge is already paid or requires refund review.');
        if (current?.stripeSessionId) throw new ConflictException('A new checkout was opened. Close it before recording a manual payment.');
      }
      const paymentIds: number[] = [];
      for (const context of contexts) {
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
            deliveryId: context.delivery?.id ?? null,
            userId: context.estimate.idUser,
            ...payer,
            baseAmount,
            surchargePercent: new Prisma.Decimal(0),
            surchargeAmount: new Prisma.Decimal(0),
            amount: baseAmount,
            currency: 'usd',
            status: PaymentStatus.PAID,
            paymentMethod: params.method,
            paymentMethodLabel: params.method === PaymentMethod.ACH ? 'Bank (ACH)' : params.method === PaymentMethod.WIRE ? 'Bank transfer' : params.method,
            stripeMethodType: null,
            stripeFundingSourceGroup: null,
            paidAt,
            manualReference: reference,
            manualNote: params.note?.trim() || null,
            recordedById: params.actor.id,
          },
          update: {
            installationJobId: context.job?.id ?? null,
            extraChargeId: context.extraCharge?.id ?? null,
            deliveryId: context.delivery?.id ?? null,
            userId: context.estimate.idUser,
            ...payer,
            baseAmount,
            surchargePercent: new Prisma.Decimal(0),
            surchargeAmount: new Prisma.Decimal(0),
            amount: baseAmount,
            currency: 'usd',
            status: PaymentStatus.PAID,
            paymentMethod: params.method,
            paymentMethodLabel: params.method === PaymentMethod.ACH ? 'Bank (ACH)' : params.method === PaymentMethod.WIRE ? 'Bank transfer' : params.method,
            stripeMethodType: null,
            stripeFundingSourceGroup: null,
            paidAt,
            manualReference: reference,
            manualNote: params.note?.trim() || null,
            recordedById: params.actor.id,
            stripeSessionId: null,
            stripePaymentIntentId: null,
            stripeCustomerId: null,
            // Un cobro manual no debe heredar la aceptación de otro checkout.
            materialAcceptanceText: null,
            materialAcceptedAt: null,
          },
        });
        await recordManualReceipt(tx, payment, `manual:${randomUUID()}`);
        paymentIds.push(payment.id);
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

      }
      for (const id of paymentIds) {
        const confirmed = await tx.payment.findUniqueOrThrow({ where: { id }, include: {
          estimate: { include: { order: true, installationJob: true, status: true, user: { include: { role: true } } } },
        } });
        await this.ensurePaidPaymentEffects(tx, confirmed);
      }
      return tx.payment.findUniqueOrThrow({
        where: { id: paymentIds[0] },
        include: { order: true },
      });
    });
  }

  private async successfulCharge(intentId: string): Promise<Stripe.Charge> {
    const intent = await this.stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    const charge = typeof intent.latest_charge === 'string'
      ? await this.stripe.charges.retrieve(intent.latest_charge) : intent.latest_charge;
    if (intent.status !== 'succeeded' || !charge?.paid || !charge.captured) {
      throw new ConflictException('Stripe has not confirmed the captured funds yet.');
    }
    return charge;
  }

  private async applyStripeRefunds(tx: Prisma.TransactionClient, charge: Stripe.Charge) {
    const refunds: Stripe.Refund[] = [];
    let after: string | undefined;
    do {
      const page = await this.stripe.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) });
      refunds.push(...page.data);
      after = page.has_more ? page.data.at(-1)?.id : undefined;
      if (page.has_more && !after) throw new Error('Incomplete Stripe refund page.');
    } while (after);
    const result = await reconcileChargeRefunds(tx, charge, refunds);
    if (result.newRefundIds.length && result.paymentIds.length) {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: result.paymentIds[0] }, include: { estimate: { select: { number: true } } } });
      for (const refundId of result.newRefundIds) await this.notifications.createAndSendToRoles(['admin'], {
        message: `Refund for Estimate #${payment.estimate.number} requires review of the remaining balance.`,
        actionUrl: `/estimates/${payment.idEst}/edit#payment-history`, actionLabel: 'Review refund',
        dedupeKey: `refund:${refundId}:review`,
      }, { db: tx });
    }
    return result;
  }

  // Se leen datos actuales de Stripe, no el estado antiguo de un webhook repetido.
  private async synchronizeStripeCharge(chargeId: string) {
    const knownReceipt = await this.prisma.paymentReceipt.findFirst({ where: { stripeChargeId: chargeId }, include: { payment: true } });
    const charge = await this.stripe.charges.retrieve(chargeId);
    const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!intentId) return;
    let payment = knownReceipt?.payment ?? await this.prisma.payment.findFirst({ where: { stripePaymentIntentId: intentId } });
    if (!payment) {
      // Un reembolso puede llegar antes que checkout.session.completed.
      const sessions = await this.stripe.checkout.sessions.list({ payment_intent: intentId, limit: 100 });
      if (sessions.data.length) payment = await this.prisma.payment.findFirst({ where: { stripeSessionId: { in: sessions.data.map(s => s.id) } } });
    }
    if (!payment) return; // El cargo no pertenece a este portal.
    const estimateId = payment.idEst;
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
      const existing = await tx.paymentReceipt.findFirst({ where: { stripeChargeId: chargeId } });
      if (!existing) {
        const current = await tx.payment.findUniqueOrThrow({ where: { id: payment!.id } });
        if (!current.stripeSessionId) throw new Error('Original Stripe checkout is missing; refund reconciliation requires review.');
        const session = await this.stripe.checkout.sessions.retrieve(current.stripeSessionId);
        await this.processPaidCheckoutSession(tx, session);
      } else {
        const latestCharge = await this.stripe.charges.retrieve(chargeId);
        const method = stripePaymentMethod(latestCharge);
        await tx.paymentReceipt.updateMany({ where: { stripeChargeId: chargeId }, data: method });
        await tx.payment.updateMany({ where: { idEst: estimateId, stripePaymentIntentId: intentId }, data: method });
        await this.applyStripeRefunds(tx, latestCharge);
      }
      await refreshScheduledInstallation(tx, estimateId);
    }, { timeout: 30000 });
  }

  private async requireEstimateAccess(estimateId: number, actor: AuthUser) {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: estimateId }, select: { id: true, idUser: true } });
    if (!estimate || (actor.role?.name !== 'admin' && estimate.idUser !== actor.id)) {
      throw new NotFoundException('Estimate not found.');
    }
    return estimate;
  }

  async getPaymentHistory(estimateId: number, actor: AuthUser) {
    await this.requireEstimateAccess(estimateId, actor);
    const payments = await this.prisma.payment.findMany({ where: { idEst: estimateId }, orderBy: { id: 'asc' }, include: {
      receipts: { orderBy: { paidAt: 'asc' }, include: { allocations: { include: { refund: true } } } },
    } });
    const admin = actor.role?.name === 'admin';
    const refunds = new Map<string, { id: string; amount: string; status: string; createdAt: Date; reviewedAt: Date | null; note?: string | null; allocations: Array<{ id: number; title: string; amount: string; principal: string; creditAmount: string }> }>();
    const receipts = payments.flatMap(payment => payment.receipts.map(receipt => {
      for (const allocation of receipt.allocations) {
        const r = allocation.refund;
        if (!refunds.has(r.id)) refunds.set(r.id, { id: r.id, amount: r.amount.toFixed(2), status: r.status,
          createdAt: r.stripeCreatedAt, reviewedAt: r.reviewedAt, ...(admin ? { note: r.reviewNote } : {}), allocations: [] });
        refunds.get(r.id)!.allocations.push({ id: allocation.id,
          title: this.paymentNotificationCopy(payment.type, payment.sequence).label,
          amount: allocation.amount.toFixed(2), principal: allocation.baseAmount.toFixed(2), creditAmount: allocation.creditAmount.toFixed(2) });
      }
      return { id: receipt.id, title: this.paymentNotificationCopy(payment.type, payment.sequence).label,
        amount: receipt.amount.toFixed(2), principal: receipt.baseAmount.toFixed(2), fee: receipt.surchargeAmount.toFixed(2),
        method: receipt.paymentMethodLabel ?? receipt.paymentMethod, paidAt: receipt.paidAt,
        refunded: receipt.allocations.filter(a => a.refund.status === 'succeeded').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)).toFixed(2) };
    }));
    // Recibos anteriores a esta migración siguen visibles mientras se sincroniza Stripe.
    for (const payment of payments.filter(p => !p.receipts.length && p.paidAt)) receipts.push({
      id: -payment.id, title: this.paymentNotificationCopy(payment.type, payment.sequence).label,
      amount: payment.amount.toFixed(2), principal: payment.baseAmount.toFixed(2), fee: payment.surchargeAmount.toFixed(2),
      method: payment.stripeSessionId ? 'Stripe — pending verification' : payment.paymentMethodLabel ?? payment.paymentMethod,
      paidAt: payment.paidAt!, refunded: payment.refundedAmount.toFixed(2),
    });
    return { receipts, refunds: [...refunds.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      reviewPending: payments.some(p => p.refundReviewPending), canReview: admin };
  }

  async synchronizeEstimatePayments(estimateId: number, actor: AuthUser) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Only administrators can reconcile Stripe payments.');
    await this.requireEstimateAccess(estimateId, actor);
    const payments = await this.prisma.payment.findMany({ where: { idEst: estimateId }, include: { receipts: true } });
    const sessions = new Set(payments.filter(p => p.stripeSessionId).map(p => p.stripeSessionId!));
    for (const sessionId of sessions) {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      if (this.isCompletedCheckout(session)) await this.prisma.$transaction(tx => this.processPaidCheckoutSession(tx, session), { timeout: 30000 });
    }
    const charges = new Set(payments.flatMap(p => p.receipts.map(r => r.stripeChargeId).filter((id): id is string => Boolean(id))));
    for (const chargeId of charges) await this.synchronizeStripeCharge(chargeId);
    return this.getPaymentHistory(estimateId, actor);
  }

  async reviewRefund(estimateId: number, refundId: string, dto: ReviewRefundDto, actor: AuthUser) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Only administrators can review refunds.');
    await this.requireEstimateAccess(estimateId, actor);
    const note = dto.note?.trim();
    if (!note || note.length < 3 || note.length > 1000) throw new BadRequestException('Explain the refund decision.');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
      const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: {
        allocations: { include: { receipt: { include: { payment: true } } } },
      } });
      if (!refund || !refund.allocations.length || refund.allocations.some(a => a.receipt.payment.idEst !== estimateId)) {
        throw new NotFoundException('Refund not found.');
      }
      if (!['pending', 'requires_action', 'succeeded'].includes(refund.status)) throw new ConflictException('This refund failed or was canceled.');
      if (!dto.allocations?.length || dto.allocations.length !== refund.allocations.length || new Set(dto.allocations.map(a => a.id)).size !== dto.allocations.length) {
        throw new BadRequestException('Review every refund allocation once.');
      }
      for (const input of dto.allocations) {
        const allocation = refund.allocations.find(a => a.id === input.id);
        if (!allocation || !Number.isFinite(input.creditAmount) || input.creditAmount < 0 || new Prisma.Decimal(input.creditAmount).decimalPlaces() > 2 ||
            new Prisma.Decimal(input.creditAmount).gt(allocation.baseAmount)) throw new BadRequestException('The approved reduction must be between zero and the refunded principal.');
      }
      if (refund.reviewedAt) {
        if (refund.reviewNote === note && dto.allocations.every(input => refund.allocations.find(a => a.id === input.id)!.creditAmount.eq(input.creditAmount))) return { reviewed: true };
        throw new ConflictException('This refund has already been reviewed. Its audit record cannot be overwritten.');
      }
      if (await tx.payment.count({ where: { idEst: estimateId, status: PaymentStatus.PENDING, stripeSessionId: { not: null } } })) {
        throw new ConflictException('Finish or cancel the active checkout before reviewing the refund.');
      }
      for (const input of dto.allocations) await tx.paymentRefundAllocation.update({ where: { id: input.id }, data: { creditAmount: input.creditAmount } });
      await tx.paymentRefund.update({ where: { id: refund.id }, data: { reviewedAt: new Date(), reviewedById: actor.id, reviewNote: note } });
      for (const paymentId of new Set(refund.allocations.map(a => a.receipt.paymentId))) await refreshPaymentAccounting(tx, paymentId);
      await refreshScheduledInstallation(tx, estimateId);
      const estimate = await tx.estimate.findUnique({ where: { id: estimateId }, include: { order: true, status: true } });
      const schedule = await getPaymentSchedule(tx, estimateId);
      if (estimate && !estimate.order && estimate.status.name === 'Active' && schedule &&
        schedule.rows.some(row => row.sequence === schedule.initialSequence && row.status === 'PAID')) {
        // Si el reembolso llegó antes de crear la orden, la decisión comercial deja
        // la creación en manos del admin, incluso cuando la cuota queda cubierta.
        const pending = await tx.estimateStatus.upsert({ where: { name: PENDING_ORDER_REVIEW }, update: {}, create: { name: PENDING_ORDER_REVIEW } });
        await tx.estimate.update({ where: { id: estimateId }, data: { statusId: pending.id } });
      }
      await tx.eventLog.create({ data: { action: 'UPDATE', entityType: 'Payment', entityId: refund.allocations[0].receipt.paymentId,
        userId: actor.id, message: `Refund ${refund.id} reviewed. Approved additional principal reduction: $${dto.allocations.reduce((sum, a) => sum.add(a.creditAmount), new Prisma.Decimal(0)).toFixed(2)}. ${note}` } });
      return { reviewed: true };
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

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.prisma.$transaction((tx) =>
        this.processPaidCheckoutSession(tx, session), { timeout: 30000 },
      );
    } else if (event.type === 'checkout.session.async_payment_failed') {
      const eventSession = event.data.object as Stripe.Checkout.Session;
      const session = await this.stripe.checkout.sessions.retrieve(eventSession.id);
      if (this.isCompletedCheckout(session)) {
        await this.prisma.$transaction(tx => this.processPaidCheckoutSession(tx, session), { timeout: 30000 });
      } else {
        await this.closeUnpaidCheckoutSession(session.id, PaymentStatus.FAILED);
      }
    } else if (['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded'].includes(event.type)) {
      const object = event.data.object as Stripe.Refund | Stripe.Charge;
      const chargeId = object.object === 'charge' ? object.id : typeof object.charge === 'string' ? object.charge : object.charge?.id;
      if (chargeId) await this.synchronizeStripeCharge(chargeId);
    }
    return { received: true };
  }
}

import { ConflictException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { cents, distributeCents } from './payment-accounting';
import { stripePaymentMethod } from './stripe-payment-method';

const activeRefund = (status: string) =>
  ['pending', 'requires_action', 'succeeded'].includes(status);
const money = (value: number) => new Prisma.Decimal(value).div(100);
type Payment = Prisma.PaymentGetPayload<{}>;

export async function recordStripeReceipt(
  tx: Prisma.TransactionClient,
  payment: Payment,
  charge: Stripe.Charge,
  sessionId: string,
) {
  const method = stripePaymentMethod(charge);
  const intentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intentId) throw new Error('Stripe charge has no PaymentIntent.');
  await tx.paymentReceipt.upsert({
    where: { sourceKey: `stripe:${charge.id}:${payment.id}` },
    create: {
      sourceKey: `stripe:${charge.id}:${payment.id}`,
      paymentId: payment.id,
      stripeChargeId: charge.id,
      stripePaymentIntentId: intentId,
      stripeSessionId: sessionId,
      amount: payment.amount,
      baseAmount: payment.baseAmount,
      surchargeAmount: payment.surchargeAmount,
      currency: payment.currency,
      paidAt: payment.paidAt ?? new Date(charge.created * 1000),
      ...method,
    },
    // Los importes del recibo original nunca se sobrescriben durante una repetición.
    update: method,
  });
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      ...(payment.stripeSessionId === sessionId ? method : {}),
      originalBaseAmount: payment.originalBaseAmount ?? payment.baseAmount,
    },
  });
}

export async function recordManualReceipt(
  tx: Prisma.TransactionClient,
  payment: Payment,
  sourceKey: string,
) {
  await tx.paymentReceipt.create({
    data: {
      sourceKey,
      paymentId: payment.id,
      amount: payment.amount,
      baseAmount: payment.baseAmount,
      surchargeAmount: payment.surchargeAmount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      paymentMethodLabel: payment.paymentMethodLabel,
      paidAt: payment.paidAt!,
      manualReference: payment.manualReference,
      manualNote: payment.manualNote,
      recordedById: payment.recordedById,
    },
  });
  if (payment.originalBaseAmount == null)
    await tx.payment.update({
      where: { id: payment.id },
      data: { originalBaseAmount: payment.baseAmount },
    });
  await refreshPaymentAccounting(tx, payment.id);
}

export async function refreshPaymentAccounting(
  tx: Prisma.TransactionClient,
  paymentId: number,
) {
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      receipts: { include: { allocations: { include: { refund: true } } } },
    },
  });
  if (!payment.receipts.length) return payment;
  let received = 0,
    refunded = 0,
    refundedPrincipal = 0,
    credit = 0,
    reviewAmount = 0;
  let review = false;
  for (const receipt of payment.receipts) {
    received += cents(receipt.baseAmount);
    for (const allocation of receipt.allocations) {
      const refund = allocation.refund;
      if (refund.status === 'succeeded') {
        refunded += cents(allocation.amount);
        refundedPrincipal += cents(allocation.baseAmount);
      }
      // La reducción comercial aprobada no se revierte si el banco devuelve el reembolso.
      if (refund.reviewedAt) credit += cents(allocation.creditAmount);
      if (activeRefund(refund.status) && !refund.reviewedAt) {
        review = true;
        reviewAmount += cents(allocation.baseAmount);
      }
    }
  }
  if (refundedPrincipal > received)
    throw new Error('Refund principal exceeds captured principal.');
  const net = received - refundedPrincipal;
  return tx.payment.update({
    where: { id: paymentId },
    data: {
      netPaidBaseAmount: money(net),
      refundedAmount: money(refunded),
      refundCreditAmount: money(credit),
      refundReviewPending: review,
      refundReviewBaseAmount: money(reviewAmount),
      ...(refunded > 0 &&
      !review &&
      payment.status !== PaymentStatus.PENDING &&
      net + credit < cents(payment.originalBaseAmount ?? payment.baseAmount)
        ? { stripeSessionId: null, stripePaymentIntentId: null }
        : {}),
      ...(refunded > 0 &&
      [PaymentStatus.PAID, PaymentStatus.REFUNDED].includes(
        payment.status as any,
      )
        ? { status: net === 0 ? PaymentStatus.REFUNDED : PaymentStatus.PAID }
        : {}),
    },
  });
}

// Se llama con Estimate bloqueado y con la lista completa y actual de Stripe.
export async function reconcileChargeRefunds(
  tx: Prisma.TransactionClient,
  charge: Stripe.Charge,
  refunds: Stripe.Refund[],
) {
  const receipts = await tx.paymentReceipt.findMany({
    where: { stripeChargeId: charge.id },
    orderBy: { id: 'asc' },
    include: { allocations: { include: { refund: true } } },
  });
  if (!receipts.length)
    return { paymentIds: [] as number[], newRefundIds: [] as string[] };
  const captured = receipts.reduce(
    (sum, receipt) => sum + cents(receipt.amount),
    0,
  );
  if (
    captured !== charge.amount_captured ||
    receipts.some((r) => r.currency !== charge.currency) ||
    refunds.some((r) => r.currency !== charge.currency)
  ) {
    throw new Error('Refund currency or captured allocation mismatch.');
  }
  const intent =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent) throw new Error('Missing refund PaymentIntent.');
  const newRefundIds: string[] = [];
  const currentStatuses = new Map(
    refunds.map((refund) => [refund.id, refund.status ?? 'pending']),
  );
  const used = receipts.map((receipt) =>
    receipt.allocations.reduce(
      (total, allocation) => {
        if (
          activeRefund(
            currentStatuses.get(allocation.refundId) ??
              allocation.refund.status,
          )
        ) {
          total.base += cents(allocation.baseAmount);
          total.fee += cents(allocation.amount) - cents(allocation.baseAmount);
        }
        return total;
      },
      { base: 0, fee: 0 },
    ),
  );
  for (const refund of [...refunds].sort(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  )) {
    const prior = await tx.paymentRefund.findUnique({
      where: { id: refund.id },
      include: { allocations: true },
    });
    const status = refund.status ?? 'pending';
    if (
      prior &&
      (cents(prior.amount) !== refund.amount ||
        prior.stripeChargeId !== charge.id)
    ) {
      throw new Error('Stripe refund identity changed.');
    }
    await tx.paymentRefund.upsert({
      where: { id: refund.id },
      create: {
        id: refund.id,
        stripeChargeId: charge.id,
        stripePaymentIntentId: intent,
        amount: money(refund.amount),
        currency: refund.currency,
        status,
        reason: refund.reason ?? null,
        failureReason: refund.failure_reason ?? null,
        stripeCreatedAt: new Date(refund.created * 1000),
      },
      update: {
        status,
        failureReason: refund.failure_reason ?? null,
        reason: refund.reason ?? null,
      },
    });
    if (!prior?.allocations.length) {
      const live = activeRefund(status);
      const capacities = receipts.flatMap((receipt, index) => [
        cents(receipt.baseAmount) - (live ? used[index].base : 0),
        cents(receipt.surchargeAmount) - (live ? used[index].fee : 0),
      ]);
      const parts = distributeCents(refund.amount, capacities);
      for (let index = 0; index < receipts.length; index++) {
        const base = parts[index * 2],
          fee = parts[index * 2 + 1];
        if (!base && !fee) continue;
        await tx.paymentRefundAllocation.create({
          data: {
            refundId: refund.id,
            receiptId: receipts[index].id,
            amount: money(base + fee),
            baseAmount: money(base),
          },
        });
        if (live) {
          used[index].base += base;
          used[index].fee += fee;
        }
      }
      if (live) newRefundIds.push(refund.id);
    }
  }
  if (
    used.some(
      (value, index) =>
        value.base > cents(receipts[index].baseAmount) ||
        value.fee > cents(receipts[index].surchargeAmount),
    )
  ) {
    throw new ConflictException('Refund allocations require reconciliation.');
  }
  const paymentIds = [...new Set(receipts.map((receipt) => receipt.paymentId))];
  for (const id of paymentIds) await refreshPaymentAccounting(tx, id);
  return { paymentIds, newRefundIds };
}

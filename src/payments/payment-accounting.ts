import Decimal from 'decimal.js';

type Money = Decimal.Value | { toString(): string } | null | undefined;
export type AccountedPayment = {
  status?: string;
  baseAmount?: Money;
  netPaidBaseAmount?: Money;
  originalBaseAmount?: Money;
  refundedAmount?: Money;
  refundCreditAmount?: Money;
  refundReviewPending?: boolean;
  refundReviewBaseAmount?: Money;
};

export const decimalAmount = (value: Money) =>
  new Decimal(value == null ? 0 : String(value));
export const paidPrincipal = (payment: AccountedPayment) =>
  payment.netPaidBaseAmount != null
    ? Decimal.max(0, decimalAmount(payment.netPaidBaseAmount))
    : payment.status === 'PAID'
      ? decimalAmount(payment.baseAmount)
      : new Decimal(0);

export const hasRefundHistory = (payment?: AccountedPayment | null) =>
  Boolean(
    payment &&
      payment.netPaidBaseAmount != null &&
      decimalAmount(payment.refundedAmount).gt(0),
  );

export const remainingRefundBalance = (payment: AccountedPayment) =>
  Decimal.max(
    0,
    decimalAmount(payment.originalBaseAmount ?? payment.baseAmount)
      .minus(paidPrincipal(payment))
      .minus(decimalAmount(payment.refundCreditAmount)),
  );

export const paymentIsCovered = (payment?: AccountedPayment | null) =>
  Boolean(
    payment &&
      !payment.refundReviewPending &&
      (hasRefundHistory(payment)
        ? remainingRefundBalance(payment).eq(0)
        : payment.status === 'PAID'),
  );

export function cents(value: Money): number {
  const amount = decimalAmount(value).mul(100);
  if (
    !amount.isInteger() ||
    !Number.isSafeInteger(amount.toNumber()) ||
    amount.lt(0)
  ) {
    throw new Error('Invalid monetary amount.');
  }
  return amount.toNumber();
}

// Reparte centavos exactos; la suma nunca supera el importe capturado disponible.
export function distributeCents(total: number, capacities: number[]): number[] {
  const capacity = capacities.reduce((sum, value) => sum + value, 0);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    capacities.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    total > capacity
  ) {
    throw new Error('Refund exceeds the unrefunded receipt amount.');
  }
  if (!capacity) return capacities.map(() => 0);
  if (!Number.isSafeInteger(capacity))
    throw new Error('Allocation capacity is too large.');
  const denominator = BigInt(capacity);
  const products = capacities.map((value) => BigInt(total) * BigInt(value));
  const result = products.map((value) => Number(value / denominator));
  const fractions = products.map((value) => value % denominator);
  let remaining = total - result.reduce((sum, value) => sum + value, 0);
  const order = capacities
    .map((_, index) => index)
    .sort((a, b) =>
      fractions[a] === fractions[b]
        ? a - b
        : fractions[a] > fractions[b]
          ? -1
          : 1,
    );
  for (const index of order) {
    if (!remaining) break;
    if (result[index] < capacities[index]) {
      result[index]++;
      remaining--;
    }
  }
  return result;
}

import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';
import { cents, distributeCents } from './payment-accounting';

const COMPONENTS = ['material', 'installation', 'permit', 'city', 'other'] as const;
type Components = Record<(typeof COMPONENTS)[number], number>;
type Status = 'PENDING' | 'CONFIRMED' | 'REVIEW';
type Receipt = {
  id: number; amount: { toString(): string }; surchargeAmount: { toString(): string };
  currency: string; processingCostSnapshot: unknown; payment: { idEst: number };
  allocations: Array<{ refundId: string; amount: { toString(): string }; baseAmount: { toString(): string } }>;
};
type FrozenReceipt = {
  receipt: Receipt; components: Components; total: number; surcharge: number; materialSurcharge: number;
  remaining: Components; refunded: number; refundedSurcharge: number;
};
type FeeResult = { fee: number | null; balanceTransactionId: string | null; status: Status };
const zero = (): Components => ({ material: 0, installation: 0, permit: 0, city: 0, other: 0 });
const money = (value: number) => new Prisma.Decimal(value).div(100);
const display = (value: number) => money(value).toFixed(2);
const object = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const componentJson = (components: Components) => Object.fromEntries(COMPONENTS.map(key => [key, display(components[key])]));
const sameComponents = (saved: unknown, components: Components) =>
  COMPONENTS.every(key => object(saved)?.[key] === display(components[key]));
const sum = (values: number[]) => {
  const value = values.reduce((total, item) => total + item, 0);
  if (!Number.isSafeInteger(value)) throw new Error('Unsafe monetary total.');
  return value;
};
const signedCents = (value: unknown) => {
  const result = new Decimal(String(value)).mul(100);
  if (!result.isFinite() || !result.isInteger() || !Number.isSafeInteger(result.toNumber())) throw new Error('Invalid saved fee.');
  return result.toNumber();
};

// Fees, including signed refund adjustments, are weights rather than capacities:
// a minimum processor fee can exceed a tiny captured amount.
function allocateFee(total: number, weights: Components): Components {
  if (!Number.isSafeInteger(total)) throw new Error('Invalid Stripe fee.');
  const capacity = sum(COMPONENTS.map(key => weights[key]));
  if (capacity <= 0) {
    if (total !== 0) throw new Error('Fee without a captured allocation.');
    return zero();
  }
  const sign = total < 0 ? -1 : 1;
  const products = COMPONENTS.map(key => BigInt(Math.abs(total)) * BigInt(weights[key]));
  const parts = products.map(value => Number(value / BigInt(capacity)));
  const remainder = products.map(value => value % BigInt(capacity));
  let missing = Math.abs(total) - sum(parts);
  const order = COMPONENTS.map((_, index) => index).sort((a, b) =>
    remainder[a] === remainder[b] ? a - b : remainder[a] > remainder[b] ? -1 : 1);
  for (const index of order) { if (!missing) break; parts[index]++; missing--; }
  return Object.fromEntries(COMPONENTS.map((key, index) => [key, sign * parts[index]])) as Components;
}

function readReceipt(receipt: Receipt): FrozenReceipt {
  const snapshot = object(receipt.processingCostSnapshot);
  const raw = object(snapshot?.components);
  if (snapshot?.version !== 1 || snapshot.allocationPending === true || !raw || typeof snapshot.total !== 'string' || typeof snapshot.materialSurcharge !== 'string')
    throw new Error('Missing or invalid processing allocation.');
  const components = zero();
  for (const key of COMPONENTS) {
    if (typeof raw[key] !== 'string') throw new Error('Invalid processing component.');
    components[key] = cents(raw[key]);
  }
  const total = cents(snapshot.total), surcharge = cents(receipt.surchargeAmount);
  const materialSurcharge = cents(snapshot.materialSurcharge);
  if (total !== cents(receipt.amount) || total !== sum(Object.values(components)) ||
      surcharge > total || materialSurcharge > surcharge || materialSurcharge > components.material)
    throw new Error('Processing allocations do not match the receipt.');
  return { receipt, components, total, surcharge, materialSurcharge,
    remaining: { ...components }, refunded: 0, refundedSurcharge: 0 };
}

async function readFee(stripe: Stripe, reference: string | Stripe.BalanceTransaction | null | undefined, currency: string, deadline: number): Promise<FeeResult> {
  const id = typeof reference === 'string' ? reference : reference?.id ?? null;
  if (!reference) return { fee: null, balanceTransactionId: null, status: 'PENDING' };
  let transaction: Stripe.BalanceTransaction;
  try {
    if (typeof reference === 'string') {
      const timeout = Math.min(2000, deadline - Date.now());
      if (timeout <= 0) return { fee: null, balanceTransactionId: id, status: 'PENDING' };
      transaction = await stripe.balanceTransactions.retrieve(reference, {}, { timeout, maxNetworkRetries: 0 });
    } else transaction = reference;
  }
  catch { return { fee: null, balanceTransactionId: id, status: 'PENDING' }; }
  if (!transaction || transaction.currency !== currency || !Number.isSafeInteger(transaction.fee))
    return { fee: null, balanceTransactionId: id, status: 'REVIEW' };
  return { fee: transaction.fee, balanceTransactionId: transaction.id, status: 'CONFIRMED' };
}

function refundWeights(refund: Stripe.Refund, receipts: FrozenReceipt[]): Components {
  if (!Number.isSafeInteger(refund.amount) || refund.amount < 0) throw new Error('Invalid refunded amount.');
  const allocations = receipts.map(item => item.receipt.allocations.filter(row => row.refundId === refund.id));
  if (allocations.some(rows => rows.length > 1)) throw new Error('Duplicate refund allocation.');
  const fromLedger = allocations.some(rows => rows.length);
  const parts = fromLedger
    ? allocations.map(rows => rows.length ? cents(rows[0].amount) : 0)
    : distributeCents(refund.amount, receipts.map(item => item.total - item.refunded));
  if (sum(parts) !== refund.amount) throw new Error('Incomplete refund allocation.');
  const result = zero();
  receipts.forEach((item, index) => {
    const amount = parts[index];
    if (amount > item.total - item.refunded) throw new Error('Refund exceeds captured allocation.');
    let refundedSurcharge: number;
    if (fromLedger) {
      const principal = allocations[index].length ? cents(allocations[index][0].baseAmount) : 0;
      if (principal > amount) throw new Error('Invalid refund principal.');
      refundedSurcharge = amount - principal;
    } else {
      const remainingSurcharge = item.surcharge - item.refundedSurcharge;
      refundedSurcharge = distributeCents(amount, [item.total - item.refunded - remainingSurcharge, remainingSurcharge])[1];
    }
    if (refundedSurcharge > item.surcharge - item.refundedSurcharge) throw new Error('Refunded surcharge exceeds receipt.');
    const componentParts = distributeCents(amount, COMPONENTS.map(key => item.remaining[key]));
    COMPONENTS.forEach((key, i) => { result[key] += componentParts[i]; item.remaining[key] -= componentParts[i]; });
    item.refunded += amount;
    item.refundedSurcharge += refundedSurcharge;
  });
  return result;
}

/** Called after ledger reconciliation, while the owning Estimate is locked.
 * A missing processor cost never rejects an otherwise confirmed customer payment.
 * Legacy receipts with no allocation snapshot are deliberately left untouched.
 */
export async function reconcileStripeProcessingCost(
  tx: Prisma.TransactionClient, stripe: Stripe, charge: Stripe.Charge, refunds: Stripe.Refund[],
) {
  const receipts = await tx.paymentReceipt.findMany({
    where: { stripeChargeId: charge.id }, orderBy: { id: 'asc' },
    include: { payment: { select: { idEst: true } }, allocations: true },
  }) as unknown as Receipt[];
  if (!receipts.length || receipts.every(receipt => receipt.processingCostSnapshot == null)) return { status: 'SKIPPED' as const };
  const existing = await tx.stripeProcessingCost.findUnique({ where: { stripeChargeId: charge.id } });
  const estimateId = existing?.estimateId ?? receipts[0].payment.idEst;
  // Cost enrichment must leave time for the already confirmed payment to commit.
  const deadline = Date.now() + 5000;
  let status: Status = 'CONFIRMED';
  let fee: number | null = null, materialFee: number | null = null, materialSurcharge = 0;
  let balanceTransactionId: string | null = null;
  let allocationSnapshot: Record<string, any> = { version: 1, materialAffected: true };
  const mark = (next: Status) => {
    if (next === 'REVIEW' || next === 'PENDING' && status !== 'REVIEW') status = next;
  };
  try {
    if (!Number.isSafeInteger(charge.amount_captured) || charge.amount_captured <= 0 ||
        receipts.some(receipt => receipt.payment.idEst !== estimateId || receipt.currency !== charge.currency))
      throw new Error('Charge allocation or currency mismatch.');
    const frozen = receipts.map(readReceipt);
    if (sum(frozen.map(item => item.total)) !== charge.amount_captured) throw new Error('Incomplete captured allocation.');
    const components = zero();
    for (const item of frozen) for (const key of COMPONENTS) components[key] += item.components[key];
    const saved = object(existing?.allocationSnapshot);
    allocationSnapshot = {
      version: 1, materialAffected: components.material > 0, components: componentJson(components),
      receipts: frozen.map(item => ({ receiptId: item.receipt.id, total: display(item.total),
        components: componentJson(item.components), materialSurcharge: display(item.materialSurcharge), surchargeAmount: display(item.surcharge) })),
      chargeFee: null, chargeMaterialFee: null, refunds: [],
    };
    const sameReceipts = saved?.receipts == null || Array.isArray(saved.receipts) &&
      saved.receipts.length === frozen.length && frozen.every((item, index) => {
        const previous = object(saved.receipts[index]);
        return previous?.receiptId === item.receipt.id && previous.total === display(item.total) &&
          previous.materialSurcharge === display(item.materialSurcharge) && previous.surchargeAmount === display(item.surcharge) &&
          sameComponents(previous.components, item.components);
      });
    if (existing && (existing.estimateId !== estimateId || existing.currency !== charge.currency ||
        cents(existing.capturedAmount) !== charge.amount_captured || !sameReceipts))
      throw new Error('Frozen processing allocation changed.');
    const original: FeeResult = saved?.chargeFee != null
      ? { fee: signedCents(saved.chargeFee), balanceTransactionId: existing!.balanceTransactionId, status: 'CONFIRMED' }
      : await readFee(stripe, charge.balance_transaction, charge.currency, deadline);
    mark(original.status);
    balanceTransactionId = original.balanceTransactionId;
    fee = original.fee;
    materialFee = original.fee === null ? components.material === 0 ? 0 : null : allocateFee(original.fee, components).material;
    allocationSnapshot.chargeFee = original.fee === null ? null : display(original.fee);
    allocationSnapshot.chargeMaterialFee = original.fee === null ? null : display(allocateFee(original.fee, components).material);
    const unique = new Map<string, Stripe.Refund>();
    for (const refund of refunds) {
      if (unique.has(refund.id) && (unique.get(refund.id)!.amount !== refund.amount || unique.get(refund.id)!.status !== refund.status))
        throw new Error('Conflicting refund identities.');
      unique.set(refund.id, refund);
    }
    // A refund that was pending can succeed after a later refund was allocated.
    // Replay saved successes first so their component cents remain immutable,
    // even when their processor fee was still unavailable.
    const savedOrder = new Map<string, number>(Array.isArray(saved?.refunds)
      ? saved.refunds.map((item: any, index: number) => [item.refundId, index]) : []);
    const succeeded = [...unique.values()].filter(item => item.status === 'succeeded').sort((a, b) => {
      const previousA = savedOrder.get(a.id), previousB = savedOrder.get(b.id);
      if (previousA !== undefined || previousB !== undefined)
        return (previousA ?? Number.MAX_SAFE_INTEGER) - (previousB ?? Number.MAX_SAFE_INTEGER);
      return a.created - b.created || a.id.localeCompare(b.id);
    });
    for (const refund of succeeded) {
      if (refund.currency !== charge.currency) throw new Error('Refund currency mismatch.');
      const weights = refundWeights(refund, frozen);
      const previous = Array.isArray(saved?.refunds) ? saved.refunds.find((item: any) => item.refundId === refund.id) : null;
      if (previous && (previous.amount !== display(refund.amount) || !sameComponents(previous.components, weights)))
        throw new Error('Frozen refund allocation changed.');
      const cost: FeeResult = previous?.fee != null
        ? { fee: signedCents(previous.fee), balanceTransactionId: previous.balanceTransactionId, status: 'CONFIRMED' }
        : await readFee(stripe, refund.balance_transaction, charge.currency, deadline);
      mark(cost.status);
      const material = cost.fee === null ? null : allocateFee(cost.fee, weights).material;
      if (cost.fee !== null) fee = (fee ?? 0) + cost.fee;
      if (material !== null) materialFee = (materialFee ?? 0) + material;
      allocationSnapshot.refunds.push({ refundId: refund.id, amount: display(refund.amount), components: componentJson(weights),
        fee: cost.fee === null ? null : display(cost.fee), materialFee: material === null ? null : display(material),
        balanceTransactionId: cost.balanceTransactionId });
    }
    materialSurcharge = sum(frozen.map(item => item.materialSurcharge - distributeCents(
      item.refundedSurcharge, [item.materialSurcharge, item.surcharge - item.materialSurcharge],
    )[0]));
  } catch {
    status = 'REVIEW';
    // Preserve already known costs when anomalous data needs investigation.
    fee = existing?.fee == null ? null : signedCents(existing.fee);
    materialFee = existing?.materialFee == null ? null : signedCents(existing.materialFee);
    materialSurcharge = existing == null ? 0 : cents(existing.materialSurcharge);
    allocationSnapshot = { ...(object(existing?.allocationSnapshot) ?? allocationSnapshot), materialAffected: true };
    balanceTransactionId = existing?.balanceTransactionId ?? balanceTransactionId;
  }
  const data = {
    estimateId, currency: existing?.currency ?? charge.currency,
    capturedAmount: existing?.capturedAmount ?? money(Number.isSafeInteger(charge.amount_captured) && charge.amount_captured >= 0 ? charge.amount_captured : 0),
    fee: fee === null ? null : money(fee), materialFee: materialFee === null ? null : money(materialFee),
    materialSurcharge: money(materialSurcharge), balanceTransactionId,
    allocationSnapshot: allocationSnapshot as Prisma.InputJsonValue, status,
    lastError: ({ CONFIRMED: null, PENDING: 'Stripe processing cost is not available yet.',
      REVIEW: 'Stripe processing allocation or currency requires review.' } as Record<Status, string | null>)[status],
  };
  await tx.stripeProcessingCost.upsert({ where: { stripeChargeId: charge.id }, create: { stripeChargeId: charge.id, ...data }, update: data });
  const costs = await tx.stripeProcessingCost.findMany({ where: { estimateId } });
  const materialCost = costs.reduce((total, cost) => total.plus(cost.materialFee ?? 0).minus(cost.materialSurcharge), new Prisma.Decimal(0));
  const pending = costs.some(cost => cost.status !== 'CONFIRMED' && object(cost.allocationSnapshot)?.materialAffected !== false);
  await tx.estimate.update({ where: { id: estimateId }, data: {
    materialProcessingCost: materialCost, materialProcessingCostPending: pending,
  } });
  return { status };
}

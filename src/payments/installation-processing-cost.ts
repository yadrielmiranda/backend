import Decimal from 'decimal.js';
import { cents, distributeCents } from './payment-accounting';
import type { ProcessingComponents } from './processing-cost-snapshot';

const parties = ['provider', 'company', 'dealer'] as const;
type Party = typeof parties[number];
type Money = { toString(): string } | string | number;
type Parts = Record<Party, number>;
type InstallationShareBasis = Record<Party, string> & { version: 1; quoteId: number; quoteVersion: number };
export type InstallationProcessingShare = Record<Party, string> & { allocationPending?: true; basis?: InstallationShareBasis };
export type FrozenInstallationShare = {
  version: 1;
  components: Record<Party, string>;
  surcharge: Record<Party, string>;
  basis?: InstallationShareBasis;
};
const zero = (): Parts => ({ provider: 0, company: 0, dealer: 0 });
const display = (value: number) => new Decimal(value).div(100).toFixed(2);
const strings = (value: Parts) => Object.fromEntries(parties.map(key => [key, display(value[key])])) as Record<Party, string>;
const sum = (value: Parts) => parties.reduce((total, key) => total + value[key], 0);
const record = (value: unknown): Record<string, any> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const readParts = (value: unknown): Parts => {
  const source = record(value);
  if (!source || parties.some(key => typeof source[key] !== 'string')) throw new Error('Invalid installation shares.');
  return Object.fromEntries(parties.map(key => [key, cents(source[key])])) as Parts;
};
const pendingShare = (): InstallationProcessingShare => ({ ...strings(zero()), allocationPending: true });
const readBasis = (value: unknown): InstallationShareBasis => {
  const source = record(value);
  if (source?.version !== 1 || !Number.isSafeInteger(source.quoteId) || source.quoteId < 1 ||
      !Number.isSafeInteger(source.quoteVersion) || source.quoteVersion < 1) throw new Error('Invalid installation basis.');
  return { version: 1, quoteId: source.quoteId, quoteVersion: source.quoteVersion, ...strings(readParts(source)) };
};
const basisKey = (value: InstallationShareBasis) => JSON.stringify([value.quoteId, value.quoteVersion, ...parties.map(key => value[key])]);

/** Uses the quote's frozen supplier cost. Discounts reduce the company margin,
 * while dealer-created increases remain a separate layer. */
export function buildInstallationProcessingShare(params: {
  quote: { id?: number; version?: number; total: Money; providerCostSnapshot?: unknown } | null | undefined;
  discountedTotal?: Money | null;
  dealerAdditions?: Money | null;
}): InstallationProcessingShare | null {
  if (!params.quote?.providerCostSnapshot) return null;
  try {
    const saved = record(params.quote.providerCostSnapshot);
    if (saved?.schema !== 1 || saved.total == null) return pendingShare();
    const provider = cents(saved.total);
    const original = cents(params.quote.total);
    const sale = cents(params.discountedTotal ?? params.quote.total);
    const dealer = cents(params.dealerAdditions ?? '0');
    if (provider > original || sale > original || sale < provider) return pendingShare();
    const values = strings({ provider, company: sale - provider, dealer });
    return { ...values, ...(params.quote.id != null && params.quote.version != null ? {
      basis: readBasis({ version: 1, quoteId: params.quote.id, quoteVersion: params.quote.version, ...values }),
    } : {}) };
  } catch { return pendingShare(); }
}

export function withInstallationProcessingShare(
  components: ProcessingComponents,
  share: InstallationProcessingShare | null | undefined,
): ProcessingComponents {
  // A replacement checkout must retain the original frozen shares.
  if (components.installationShare || components.installationSharePending || !share || cents(components.installation) === 0)
    return components;
  try {
    if (share.allocationPending) return { ...components, installationSharePending: true };
    const values = readParts(share);
    const amount = cents(components.installation);
    if (amount > sum(values)) return { ...components, installationSharePending: true };
    const allocated = distributeCents(amount, parties.map(key => values[key]));
    return { ...components, installationShare: {
      ...strings(Object.fromEntries(parties.map((key, index) => [key, allocated[index]])) as Parts),
      ...(share.basis ? { basis: readBasis(share.basis) } : {}),
    } };
  } catch { return { ...components, installationSharePending: true }; }
}

export function freezeInstallationProcessingShare(share: InstallationProcessingShare, base: number, surcharge: number): FrozenInstallationShare {
  const values = readParts(share);
  if (share.allocationPending || sum(values) !== base) throw new Error('Installation principal mismatch.');
  const fees = distributeCents(surcharge, parties.map(key => values[key]));
  return {
    version: 1,
    components: strings(Object.fromEntries(parties.map((key, index) => [key, values[key] + fees[index]])) as Parts),
    surcharge: strings(Object.fromEntries(parties.map((key, index) => [key, fees[index]])) as Parts),
    ...(share.basis ? { basis: readBasis(share.basis) } : {}),
  };
}

export function restoreInstallationProcessingShare(saved: unknown, amount: string): InstallationProcessingShare {
  const snapshot = record(saved);
  if (snapshot?.version !== 1) throw new Error('Invalid installation snapshot.');
  const values = readParts(snapshot.components);
  const surcharge = readParts(snapshot.surcharge);
  if (parties.some(key => surcharge[key] > values[key])) throw new Error('Invalid installation surcharge.');
  const allocated = distributeCents(cents(amount), parties.map(key => values[key]));
  return { ...strings(Object.fromEntries(parties.map((key, index) => [key, allocated[index]])) as Parts),
    ...(snapshot.basis ? { basis: readBasis(snapshot.basis) } : {}) };
}

// Processor fees are weights, not capacities: a fixed fee may exceed a small
// captured amount, and refund fee adjustments can be negative.
function allocateFee(total: number, weights: number[]): number[] {
  const capacity = weights.reduce((value, next) => value + next, 0);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(capacity) || capacity < 0) throw new Error('Invalid processor allocation.');
  if (!capacity) {
    if (total) throw new Error('Fee without a captured allocation.');
    return weights.map(() => 0);
  }
  const products = weights.map(value => BigInt(Math.abs(total)) * BigInt(value));
  const parts = products.map(value => Number(value / BigInt(capacity)));
  const remainder = products.map(value => value % BigInt(capacity));
  let missing = Math.abs(total) - parts.reduce((value, next) => value + next, 0);
  const order = weights.map((_, index) => index).sort((a, b) => remainder[a] === remainder[b] ? a - b : remainder[a] > remainder[b] ? -1 : 1);
  for (const index of order) { if (!missing) break; parts[index]++; missing--; }
  return parts.map(value => total < 0 ? -value : value);
}
const signedCents = (value: unknown) => {
  const parsed = new Decimal(String(value)).mul(100);
  if (!parsed.isFinite() || !parsed.isInteger() || !Number.isSafeInteger(parsed.toNumber())) throw new Error('Invalid fee.');
  return parsed.toNumber();
};

type CostStatus = 'CONFIRMED' | 'PENDING' | 'REVIEW' | 'UNALLOCATED' | 'NONE';
export type InstallationProcessingPartySummary = {
  collected: string;
  processingFee: string | null;
  surcharge: string;
  netProcessingCost: string | null;
  netCollected: string | null;
};
export type InstallationProcessingSummary = { status: CostStatus } & Record<Party, InstallationProcessingPartySummary>;

type Receipt = {
  id: number;
  amount: Money;
  surchargeAmount: Money;
  processingCostSnapshot: unknown;
  allocations: Array<{ refundId: string; amount: Money; baseAmount: Money }>;
};
const componentKeys = ['material', 'installation', 'permit', 'city', 'other'] as const;

type CheckoutReceipt = Omit<Receipt, 'allocations'> & {
  stripeChargeId?: string | null;
  payment?: { type: string };
  allocations: Array<Receipt['allocations'][number] & { refund?: { status: string } }>;
};
type CapturedProcessingCost = { stripeChargeId: string; status: string; allocationSnapshot: unknown };

/** Reserve principal cents after partial selection and before freezing checkout
 * snapshots. Every later capture uses the remaining frozen capacities, including
 * other open checkouts, so the final payment closes each party's exact total. */
export function allocateInstallationCheckoutShares(
  contexts: Array<{ processingComponents?: ProcessingComponents }>,
  receipts: CheckoutReceipt[],
  costs: CapturedProcessingCost[],
  reservations: CheckoutReceipt[] = [],
): void {
  const targets = contexts.filter(context => context.processingComponents?.installationShare?.basis &&
    !context.processingComponents.installationSharePending && !context.processingComponents.allocationPending &&
    cents(context.processingComponents.installation) > 0);
  if (!targets.length) return;
  try {
    const basis = readBasis(targets[0].processingComponents!.installationShare!.basis);
    const key = basisKey(basis);
    if (targets.some(context => basisKey(readBasis(context.processingComponents!.installationShare!.basis)) !== key))
      throw new Error('Multiple installation obligations in one checkout.');
    const remaining = readParts(basis);
    const grouped = new Map<string, CheckoutReceipt[]>();
    const seen = new Set<number>();
    for (const item of [...receipts, ...reservations]) {
      if (seen.has(item.id)) throw new Error('Duplicate captured or reserved receipt.');
      seen.add(item.id);
      const snapshot = record(item.processingCostSnapshot);
      if (!snapshot && item.payment && !['INSTALLMENT', 'INSTALLATION', 'INSTALLATION_DEPOSIT'].includes(item.payment.type)) continue;
      if (snapshot?.version !== 1 || snapshot.allocationPending || !snapshot.components ||
          componentKeys.reduce((value, component) => value + cents(snapshot.components[component]), 0) !== cents(item.amount))
        throw new Error('Unknown previous installation principal.');
      const group = item.stripeChargeId ?? `receipt:${item.id}`;
      grouped.set(group, [...(grouped.get(group) ?? []), item]);
    }
    for (const [chargeId, group] of grouped) {
      const installed = group.filter(item => cents(record(item.processingCostSnapshot)!.components.installation) > 0);
      if (!installed.length) continue;
      if (group.some(item => item.allocations.some(row => !row.refund?.status))) throw new Error('Unknown refund status.');
      const successes = group.flatMap(item => item.allocations.filter(row => row.refund!.status === 'succeeded'));
      // A completely refunded receipt consumes no principal capacity, even when
      // its historical supplier metadata was unavailable.
      if (group.every(item => cents(item.amount) - cents(item.surchargeAmount) ===
          item.allocations.filter(row => row.refund!.status === 'succeeded').reduce((value, row) => value + cents(row.baseAmount), 0))) continue;
      const principal = zero();
      for (const item of installed) {
        const snapshot = record(item.processingCostSnapshot)!;
        const frozen = record(snapshot.installationShare);
        if (snapshot.installationSharePending || frozen?.version !== 1 || basisKey(readBasis(frozen.basis)) !== key)
          throw new Error('Previous installation basis is unavailable or changed.');
        const captured = readParts(frozen.components), surcharge = readParts(frozen.surcharge);
        if (sum(captured) !== cents(snapshot.components.installation) || sum(surcharge) > cents(item.surchargeAmount) ||
            parties.some(party => surcharge[party] > captured[party])) throw new Error('Invalid previous installation split.');
        for (const party of parties) principal[party] += captured[party] - surcharge[party];
      }
      if (successes.length) {
        const cost = costs.find(item => item.stripeChargeId === chargeId);
        const saved = record(cost?.allocationSnapshot);
        const refundAmounts = new Map<string, number>();
        for (const row of successes) refundAmounts.set(row.refundId, (refundAmounts.get(row.refundId) ?? 0) + cents(row.amount));
        if (!saved || cost?.status === 'REVIEW' || !Array.isArray(saved.refunds) || saved.refunds.length !== refundAmounts.size ||
            saved.refunds.some((row: any) => cents(row.amount) !== refundAmounts.get(row.refundId)))
          throw new Error('Refund principal has not been reconciled.');
        // Replay the saved success order, including pending processor fees. Fee
        // availability does not change the known net principal remaining.
        const replay = buildInstallationProcessingAllocation(group, saved, 'PENDING', saved.installationProcessing);
        if (!replay || ['REVIEW', 'UNALLOCATED'].includes(replay.status) || parties.some(party => !replay[party]))
          throw new Error('Refund shares cannot be reconstructed.');
        for (const party of parties) principal[party] = cents(replay[party].collected);
      }
      for (const party of parties) {
        remaining[party] -= principal[party];
        if (remaining[party] < 0) throw new Error('Captured principal exceeds installation basis.');
      }
    }
    const selected = targets.map(context => {
      const components = context.processingComponents!;
      const allocated = distributeCents(cents(components.installation), parties.map(party => remaining[party]));
      const values = zero();
      parties.forEach((party, index) => { values[party] = allocated[index]; remaining[party] -= allocated[index]; });
      return { ...components, installationShare: { ...strings(values), basis } };
    });
    targets.forEach((context, index) => { context.processingComponents = selected[index]; });
  } catch {
    for (const context of targets) {
      const { installationShare: _share, ...components } = context.processingComponents!;
      context.processingComponents = { ...components, installationSharePending: true };
    }
  }
}

/** Enriches the existing reconciled capture. Never reads mutable estimate rates
 * or creates a provider payout. Receipts predating supplier snapshots stay unallocated. */
export function buildInstallationProcessingAllocation(
  receipts: Receipt[], allocation: Record<string, any>, status: string, previous?: unknown,
): Record<string, any> | undefined {
  const saved = record(previous);
  try {
    const frozen = receipts.map(receipt => {
      const snapshot = record(receipt.processingCostSnapshot)!;
      const components = componentKeys.map(key => cents(snapshot.components[key]));
      const raw = record(snapshot.installationShare);
      const known = raw?.version === 1 && !snapshot.installationSharePending;
      const parts = known ? readParts(raw.components) : zero();
      const surcharge = known ? readParts(raw.surcharge) : zero();
      if (known && (sum(parts) !== components[1] || parties.some(key => surcharge[key] > parts[key]) || sum(surcharge) > cents(receipt.surchargeAmount)))
        throw new Error('Invalid frozen installation breakdown.');
      return { receipt, components, remaining: [...components], parts, remainingParts: { ...parts }, surcharge,
        retainedSurcharge: { ...surcharge }, refunded: 0, refundedSurcharge: 0,
        obligation: raw?.basis ? readBasis(raw.basis) : null,
        known, installation: components[1], pending: snapshot.installationSharePending === true };
    });
    if (!frozen.some(item => item.installation > 0)) return undefined;
    const basis = frozen.filter(item => item.installation > 0).map(item => ({
      receiptId: item.receipt.id, installation: display(item.installation),
      parts: strings(item.parts), surcharge: strings(item.surcharge), known: item.known, pending: item.pending,
      ...(item.obligation ? { obligation: item.obligation } : {}),
    }));
    const sameBasis = (left: unknown, right: typeof basis) => {
      if (!Array.isArray(left) || left.length !== right.length) return false;
      return right.every((row, i) => left[i]?.receiptId === row.receiptId && left[i]?.installation === row.installation &&
        left[i]?.known === row.known && left[i]?.pending === row.pending &&
        (left[i]?.obligation == null && row.obligation == null || left[i]?.obligation != null && row.obligation != null &&
          basisKey(readBasis(left[i].obligation)) === basisKey(row.obligation)) &&
        parties.every(key => left[i]?.parts?.[key] === row.parts[key] && left[i]?.surcharge?.[key] === row.surcharge[key]));
    };
    if (saved?.basis && !sameBasis(saved.basis, basis)) throw new Error('Frozen installation breakdown changed.');
    const captured = zero(), fees = zero();
    for (const item of frozen) for (const key of parties) captured[key] += item.parts[key];
    const unallocated = frozen.filter(item => !item.known).reduce((value, item) => value + item.installation, 0);
    let feePending = false;
    const applyFee = (fee: unknown, components: number[], weights: Parts, unknown: number) => {
      if (components[1] === 0) return strings(zero());
      if (fee == null) { feePending = true; return null; }
      const installationFee = allocateFee(signedCents(fee), components)[1];
      const amounts = allocateFee(installationFee, [...parties.map(key => weights[key]), unknown]);
      for (const [index, key] of parties.entries()) fees[key] += amounts[index];
      return strings(Object.fromEntries(parties.map((key, index) => [key, amounts[index]])) as Parts);
    };
    const chargeFee = applyFee(allocation.chargeFee, componentKeys.map(key => cents(allocation.components[key])), captured, unallocated);
    const refunds: Record<string, any>[] = [];
    for (const refund of allocation.refunds ?? []) {
      const weights = zero();
      let unknown = 0;
      const ledger = frozen.map(item => item.receipt.allocations.filter(row => row.refundId === refund.refundId));
      if (ledger.some(rows => rows.length > 1)) throw new Error('Duplicate refund allocation.');
      const hasLedger = ledger.some(rows => rows.length);
      const amounts = hasLedger ? ledger.map(rows => rows.length ? cents(rows[0].amount) : 0)
        : distributeCents(cents(refund.amount), frozen.map(item => cents(item.receipt.amount) - item.refunded));
      if (amounts.reduce((value, next) => value + next, 0) !== cents(refund.amount)) throw new Error('Refund allocation mismatch.');
      const refundComponents = componentKeys.map(() => 0);
      frozen.forEach((item, index) => {
        const amount = amounts[index];
        const portions = distributeCents(amount, item.remaining);
        portions.forEach((value, i) => { refundComponents[i] += value; item.remaining[i] -= value; });
        const receiptSurcharge = cents(item.receipt.surchargeAmount);
        const refundedSurcharge = hasLedger ? amount - (ledger[index].length ? cents(ledger[index][0].baseAmount) : 0)
          : distributeCents(amount, [cents(item.receipt.amount) - item.refunded - receiptSurcharge + item.refundedSurcharge, receiptSurcharge - item.refundedSurcharge])[1];
        if (refundedSurcharge < 0 || refundedSurcharge > receiptSurcharge - item.refundedSurcharge) throw new Error('Invalid surcharge refund.');
        item.refunded += amount;
        item.refundedSurcharge += refundedSurcharge;
        if (item.known) {
          const allocated = distributeCents(portions[1], parties.map(key => item.remainingParts[key]));
          parties.forEach((key, i) => { weights[key] += allocated[i]; item.remainingParts[key] -= allocated[i]; });
          // Retain only surcharge not returned to the customer. The remainder
          // belongs to other service buckets and is never assigned to a party.
          const retained = distributeCents(item.refundedSurcharge, [...parties.map(key => item.surcharge[key]), receiptSurcharge - sum(item.surcharge)]);
          parties.forEach((key, i) => { item.retainedSurcharge[key] = item.surcharge[key] - retained[i]; });
        } else unknown += portions[1];
      });
      if (componentKeys.some((key, i) => refundComponents[i] !== cents(refund.components[key]))) throw new Error('Frozen refund breakdown changed.');
      const previousRefund = Array.isArray(saved?.refunds) ? saved.refunds.find((row: any) => row.refundId === refund.refundId) : null;
      if (previousRefund && parties.some(key => previousRefund.components?.[key] !== display(weights[key])))
        throw new Error('Frozen installation refund shares changed.');
      const fee = applyFee(refund.fee, refundComponents, weights, unknown);
      refunds.push({ refundId: refund.refundId, components: strings(weights), fee });
    }
    const resultStatus: CostStatus = status === 'REVIEW' ? 'REVIEW'
      : frozen.some(item => item.pending) ? 'PENDING'
      : unallocated > 0 ? 'UNALLOCATED' : feePending ? 'PENDING' : 'CONFIRMED';
    const result: Record<string, any> = { version: 1, status: resultStatus, basis, chargeFee, refunds };
    for (const key of parties) {
      const remaining = frozen.reduce((value, item) => value + item.remainingParts[key], 0);
      const surcharge = frozen.reduce((value, item) => value + item.retainedSurcharge[key], 0);
      const principal = remaining - surcharge;
      if (principal < 0) throw new Error('Refund allocation leaves invalid principal.');
      const knownFee = resultStatus === 'CONFIRMED';
      result[key] = { collected: display(principal), surcharge: display(surcharge),
        processingFee: knownFee ? display(fees[key]) : null,
        netProcessingCost: knownFee ? display(fees[key] - surcharge) : null,
        netCollected: knownFee ? display(remaining - fees[key]) : null };
    }
    return result;
  } catch {
    return { ...(saved ?? {}), version: 1, status: 'REVIEW' };
  }
}

export function aggregateInstallationProcessingCosts(costs: Array<{ status?: string; allocationSnapshot?: unknown }>): InstallationProcessingSummary {
  const rows = costs.map(cost => ({ cost, snapshot: record(cost.allocationSnapshot) }))
    .filter(({ snapshot }) => snapshot?.installationProcessing || Number(snapshot?.components?.installation ?? 0) > 0);
  const priority: CostStatus[] = ['NONE', 'CONFIRMED', 'UNALLOCATED', 'PENDING', 'REVIEW'];
  let status: CostStatus = rows.length ? 'CONFIRMED' : 'NONE';
  for (const { cost, snapshot } of rows) {
    const savedStatus: CostStatus = cost.status === 'REVIEW' ? 'REVIEW'
      : snapshot?.installationProcessing?.status ?? 'UNALLOCATED';
    if (!priority.includes(savedStatus)) { status = 'REVIEW'; break; }
    if (priority.indexOf(savedStatus) > priority.indexOf(status)) status = savedStatus;
  }
  const result = { status } as InstallationProcessingSummary;
  for (const key of parties) {
    const total = (field: keyof InstallationProcessingPartySummary) => rows.reduce((value, { snapshot }) =>
      value.add(String(snapshot?.installationProcessing?.[key]?.[field] ?? '0')), new Decimal(0)).toFixed(2);
    const known = status === 'CONFIRMED' || status === 'NONE';
    result[key] = { collected: total('collected'), surcharge: total('surcharge'),
      processingFee: known ? total('processingFee') : null,
      netProcessingCost: known ? total('netProcessingCost') : null,
      netCollected: known ? total('netCollected') : null };
  }
  return result;
}

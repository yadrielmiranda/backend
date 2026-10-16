import Decimal from 'decimal.js';
import { aggregateInstallationProcessingCosts, allocateInstallationCheckoutShares, buildInstallationProcessingAllocation, buildInstallationProcessingShare, withInstallationProcessingShare } from './installation-processing-cost';
import { freezeProcessingCostSnapshot, refundedProcessingComponents, singleProcessingComponent } from './processing-cost-snapshot';
import { partialProcessingComponents } from './custom-payment-allocation';
import { presentApiResponse } from '@/common/response-privacy.interceptor';

const quote = (provider = '150', sale = '180') => ({ total: sale, providerCostSnapshot: { schema: 1, total: provider } });
function receipt(dealer = '0', surcharge = '0') {
  const base = new Decimal(180).add(dealer).toFixed(2);
  const share = buildInstallationProcessingShare({ quote: quote(), dealerAdditions: dealer });
  const components = withInstallationProcessingShare(singleProcessingComponent('installation', base), share);
  return { id: 1, amount: new Decimal(base).add(surcharge), surchargeAmount: surcharge, allocations: [] as any[],
    processingCostSnapshot: freezeProcessingCostSnapshot({ baseAmount: base, surchargeAmount: surcharge,
      totalAmount: new Decimal(base).add(surcharge), processingComponents: components }) as any };
}
function allocation(item: ReturnType<typeof receipt>, fee: string | null = '5.40') {
  return { components: item.processingCostSnapshot.components, chargeFee: fee, refunds: [] as any[] };
}

function smallCheckout(amount = '0.01', surcharge = '0') {
  return { baseAmount: new Decimal(amount), surchargeAmount: new Decimal(surcharge), totalAmount: new Decimal(amount).add(surcharge),
    processingComponents: withInstallationProcessingShare(singleProcessingComponent('installation', amount),
      buildInstallationProcessingShare({ quote: { ...quote('0.01', '0.03'), id: 7, version: 1 } })) };
}
function smallReceipt(context: ReturnType<typeof smallCheckout>, id: number) {
  return { id, stripeChargeId: `ch_${id}`, amount: context.totalAmount, surchargeAmount: context.surchargeAmount,
    allocations: [] as any[], processingCostSnapshot: freezeProcessingCostSnapshot(context) as any };
}

describe('Installation principal cents across checkouts', () => {
  it('conserves one supplier cent and two company cents across three one-cent partial captures and replay', () => {
    const receipts: ReturnType<typeof smallReceipt>[] = [];
    const shares: string[] = [];
    for (let index = 0; index < 3; index++) {
      const context = smallCheckout(new Decimal(3 - index).div(100).toFixed(2));
      context.baseAmount = context.totalAmount = new Decimal('0.01');
      context.processingComponents = partialProcessingComponents(context.processingComponents, context.baseAmount);
      const replay = { ...context, processingComponents: { ...context.processingComponents } };
      allocateInstallationCheckoutShares([context], receipts, []);
      allocateInstallationCheckoutShares([replay], receipts, []);
      expect(replay.processingComponents).toEqual(context.processingComponents);
      shares.push(context.processingComponents.installationShare!.provider);
      receipts.push(smallReceipt(context, index + 1));
    }
    expect(shares).toEqual(['0.00', '0.01', '0.00']);
    expect(receipts.reduce((value, item) => value.add(item.processingCostSnapshot.installationShare.components.company), new Decimal(0)).toFixed(2)).toBe('0.02');
    expect(receipts.every(item => item.processingCostSnapshot.installationShare.basis.quoteId === 7)).toBe(true);
  });

  it('reserves each selected installment before allocating the next in one checkout', () => {
    const contexts = [smallCheckout(), smallCheckout(), smallCheckout()];
    allocateInstallationCheckoutShares(contexts, [], []);
    expect(contexts.map(item => item.processingComponents.installationShare!.provider)).toEqual(['0.00', '0.01', '0.00']);
    expect(contexts.some(item => item.processingComponents.installationSharePending)).toBe(false);
  });

  it('reserves only another open checkout attempt and releases it when canceled', () => {
    const open = smallCheckout();
    allocateInstallationCheckoutShares([open], [], []);
    const reserved = { ...smallReceipt(open, -1), stripeChargeId: null };
    const selected = smallCheckout();
    allocateInstallationCheckoutShares([selected], [], [], [reserved]);
    expect(selected.processingComponents.installationShare!.provider).toBe('0.01');
    const afterCancel = smallCheckout('0.02');
    allocateInstallationCheckoutShares([afterCancel], [smallReceipt(selected, 2)], []);
    expect(afterCancel.processingComponents.installationShare).toMatchObject({ provider: '0.00', company: '0.02' });
  });

  it('restores refunded principal capacity without charging the old surcharge or exceeding any party', () => {
    const original = smallCheckout('0.03', '0.01');
    allocateInstallationCheckoutShares([original], [], []);
    const prior = smallReceipt(original, 1);
    prior.allocations = [{ refundId: 're_1', amount: '0.02', baseAmount: '0.01', refund: { status: 'succeeded' } }];
    const saved: any = { components: prior.processingCostSnapshot.components, chargeFee: '0.00',
      refunds: [{ refundId: 're_1', amount: '0.02', fee: '0.00', components: singleProcessingComponent('installation', '0.02') }] };
    saved.installationProcessing = buildInstallationProcessingAllocation([prior], saved, 'CONFIRMED');
    expect(saved.installationProcessing.provider.collected).toBe('0.00');
    expect(saved.installationProcessing.company.collected).toBe('0.02');
    const context = smallCheckout();
    context.processingComponents = refundedProcessingComponents(prior.processingCostSnapshot, '0.01');
    expect(context.processingComponents.installationShare!.basis).toEqual(prior.processingCostSnapshot.installationShare.basis);
    const costs = [{ stripeChargeId: prior.stripeChargeId, status: 'CONFIRMED', allocationSnapshot: saved }];
    allocateInstallationCheckoutShares([context], [prior], costs);
    expect(context.processingComponents.installationShare).toMatchObject({ provider: '0.01', company: '0.00', dealer: '0.00' });
    const closed = smallCheckout();
    allocateInstallationCheckoutShares([closed], [prior, smallReceipt(context, 2)], costs);
    expect(closed.processingComponents.installationSharePending).toBe(true);
  });

  it('marks unreconciled refunds and missing prior basis pending without inventing a remainder', () => {
    const prior = smallReceipt(smallCheckout(), 1);
    const context = smallCheckout();
    delete prior.processingCostSnapshot.installationShare.basis;
    allocateInstallationCheckoutShares([context], [prior], []);
    expect(context.processingComponents.installationSharePending).toBe(true);
    const refunded = smallReceipt(smallCheckout('0.03'), 2);
    refunded.allocations = [{ refundId: 're_2', amount: '0.01', baseAmount: '0.01', refund: { status: 'succeeded' } }];
    const replacement = smallCheckout();
    allocateInstallationCheckoutShares([replacement], [refunded], []);
    expect(replacement.processingComponents.installationSharePending).toBe(true);
  });

  it('leaves legacy checkout snapshots unchanged and ignores a fully refunded old obligation', () => {
    const legacy = smallCheckout();
    delete legacy.processingComponents.installationShare!.basis;
    const original = JSON.parse(JSON.stringify(legacy.processingComponents));
    allocateInstallationCheckoutShares([legacy], [], []);
    expect(legacy.processingComponents).toEqual(original);
    const refunded = smallReceipt(smallCheckout('0.03'), 1);
    delete refunded.processingCostSnapshot.installationShare.basis;
    refunded.allocations = [{ refundId: 're_all', amount: '0.03', baseAmount: '0.03', refund: { status: 'succeeded' } }];
    const replacement = smallCheckout('0.03');
    allocateInstallationCheckoutShares([replacement], [refunded], []);
    expect(replacement.processingComponents.installationShare).toMatchObject({ provider: '0.01', company: '0.02' });
  });
});

describe('Installation supplier and company processing shares', () => {
  it('preserves the supplier minimum and applies company margins above the complete supplier cost', () => {
    expect(buildInstallationProcessingShare({ quote: quote('500', '560') })).toEqual({ provider: '500.00', company: '60.00', dealer: '0.00' });
    expect(buildInstallationProcessingShare({ quote: quote(), discountedTotal: '160', dealerAdditions: '20' }))
      .toEqual({ provider: '150.00', company: '10.00', dealer: '20.00' });
    expect(buildInstallationProcessingShare({ quote: quote(), discountedTotal: '149' })?.allocationPending).toBe(true);
    expect(buildInstallationProcessingShare({ quote: { total: '180' } })).toBeNull();
  });

  it('scales selected partial payments and freezes the allocated surcharge separately', () => {
    const components = withInstallationProcessingShare(singleProcessingComponent('installation', '180'), buildInstallationProcessingShare({ quote: quote() }));
    const partial = partialProcessingComponents(components, new Decimal('90'));
    expect(partial.installationShare).toEqual({ provider: '75.00', company: '15.00', dealer: '0.00' });
    const saved: any = freezeProcessingCostSnapshot({ baseAmount: '90', surchargeAmount: '2.70', totalAmount: '92.70', processingComponents: partial });
    expect(saved.installationShare).toEqual({ version: 1,
      components: { provider: '77.25', company: '15.45', dealer: '0.00' },
      surcharge: { provider: '2.25', company: '0.45', dealer: '0.00' } });
    expect(saved.components.installation).toBe('92.70');
  });

  it('retains the original proportions on a replacement checkout without charging the old surcharge again', () => {
    const original = receipt('0', '5.40');
    const restored = refundedProcessingComponents(original.processingCostSnapshot, '90');
    expect(restored.installationShare).toEqual({ provider: '75.00', company: '15.00', dealer: '0.00' });
    expect(withInstallationProcessingShare(restored, buildInstallationProcessingShare({ quote: quote('100', '180') }))).toEqual(restored);
  });

  it('allocates the 3% fee to provider, profile margin and dealer increases exactly once', () => {
    const item = receipt('20');
    const result = buildInstallationProcessingAllocation([item], allocation(item, '6.00'), 'CONFIRMED')!;
    expect(result.status).toBe('CONFIRMED');
    expect(result.provider).toEqual({ collected: '150.00', processingFee: '4.50', surcharge: '0.00', netProcessingCost: '4.50', netCollected: '145.50' });
    expect(result.company).toEqual({ collected: '30.00', processingFee: '0.90', surcharge: '0.00', netProcessingCost: '0.90', netCollected: '29.10' });
    expect(result.dealer).toEqual({ collected: '20.00', processingFee: '0.60', surcharge: '0.00', netProcessingCost: '0.60', netCollected: '19.40' });
    expect(buildInstallationProcessingAllocation([item], allocation(item, '6.00'), 'CONFIRMED', result)).toEqual(result);
  });

  it('separates recovered surcharge from the real processor fee', () => {
    const item = receipt('0', '5.40');
    const result = buildInstallationProcessingAllocation([item], allocation(item, '5.56'), 'CONFIRMED')!;
    expect(result.provider).toMatchObject({ collected: '150.00', surcharge: '4.50', processingFee: '4.63', netProcessingCost: '0.13', netCollected: '149.87' });
    expect(result.company).toMatchObject({ surcharge: '0.90', processingFee: '0.93', netProcessingCost: '0.03', netCollected: '29.97' });
  });

  it('replays partial refunds and signed fee adjustments from frozen receipts', () => {
    const item = receipt();
    item.allocations = [{ refundId: 're_1', amount: '90', baseAmount: '90' }];
    const cost = allocation(item);
    cost.refunds = [{ refundId: 're_1', amount: '90.00', fee: '-0.54', components: singleProcessingComponent('installation', '90') }];
    const result = buildInstallationProcessingAllocation([item], cost, 'CONFIRMED')!;
    expect(result.provider).toMatchObject({ collected: '75.00', processingFee: '4.05', netCollected: '70.95' });
    expect(result.company).toMatchObject({ collected: '15.00', processingFee: '0.81', netCollected: '14.19' });
    expect(buildInstallationProcessingAllocation([item], cost, 'CONFIRMED', result)).toEqual(result);
  });

  it('retains nonrefunded processor costs after all principal and surcharge are refunded', () => {
    const item = receipt('0', '5.40');
    item.allocations = [{ refundId: 're_all', amount: '185.40', baseAmount: '180' }];
    const cost = allocation(item, '5.56');
    cost.refunds = [{ refundId: 're_all', amount: '185.40', fee: '0.00', components: singleProcessingComponent('installation', '185.40') }];
    const result = buildInstallationProcessingAllocation([item], cost, 'CONFIRMED')!;
    expect(result.provider).toMatchObject({ collected: '0.00', surcharge: '0.00', processingFee: '4.63', netCollected: '-4.63' });
    expect(result.company).toMatchObject({ collected: '0.00', surcharge: '0.00', processingFee: '0.93', netCollected: '-0.93' });
  });

  it('leaves missing historical shares unallocated and unavailable fees pending', () => {
    const item = receipt();
    const pending = buildInstallationProcessingAllocation([item], allocation(item, null), 'PENDING')!;
    expect(pending.status).toBe('PENDING');
    expect(pending.provider.processingFee).toBeNull();
    delete item.processingCostSnapshot.installationShare;
    const historical = buildInstallationProcessingAllocation([item], allocation(item), 'CONFIRMED')!;
    expect(historical.status).toBe('UNALLOCATED');
    expect(historical.provider.netCollected).toBeNull();
  });

  it('preserves known figures and marks changed frozen shares for review', () => {
    const item = receipt();
    const saved = buildInstallationProcessingAllocation([item], allocation(item), 'CONFIRMED')!;
    item.processingCostSnapshot.installationShare.components = { provider: '100.00', company: '80.00', dealer: '0.00' };
    const changed = buildInstallationProcessingAllocation([item], allocation(item), 'CONFIRMED', saved)!;
    expect(changed.status).toBe('REVIEW');
    expect(changed.provider).toEqual(saved.provider);
  });

  it('does not move an already allocated refund between receipts with different supplier shares', () => {
    const first = receipt(), second = receipt();
    second.id = 2;
    second.processingCostSnapshot.installationShare.components = { provider: '100.00', company: '80.00', dealer: '0.00' };
    const refund = { refundId: 're_first', amount: '180', baseAmount: '180' };
    first.allocations = [refund];
    const cost = { components: singleProcessingComponent('installation', '360'), chargeFee: '10.80',
      refunds: [{ refundId: refund.refundId, amount: '180.00', fee: '0.00', components: singleProcessingComponent('installation', '180') }] };
    const saved = buildInstallationProcessingAllocation([first, second], cost, 'CONFIRMED')!;
    expect(saved.status).toBe('CONFIRMED');
    first.allocations = []; second.allocations = [refund];
    const changed = buildInstallationProcessingAllocation([first, second], cost, 'CONFIRMED', saved)!;
    expect(changed.status).toBe('REVIEW');
    expect(changed.provider).toEqual(saved.provider);
  });

  it('aggregates captured costs without inventing payouts and keeps summaries admin-only', () => {
    const item = receipt();
    const processing = buildInstallationProcessingAllocation([item], allocation(item), 'CONFIRMED')!;
    const summary = aggregateInstallationProcessingCosts([{ status: 'CONFIRMED', allocationSnapshot: { installationProcessing: processing } }]);
    expect(summary.status).toBe('CONFIRMED');
    expect(summary.provider.netCollected).toBe('145.50');
    expect(aggregateInstallationProcessingCosts([]).status).toBe('NONE');
    for (const role of ['dealer', 'operator', 'technician', 'client']) {
      expect(presentApiResponse({ installationProcessingSummary: summary, quote: quote() }, { id: 1, role: { name: role } } as any))
        .toEqual({ quote: { total: '180' } });
    }
    expect(presentApiResponse({ installationProcessingSummary: summary }, { id: 1, role: { name: 'admin' } } as any)).toHaveProperty('installationProcessingSummary');
  });
});

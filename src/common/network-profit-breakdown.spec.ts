import Decimal from 'decimal.js';
import type { NetworkSnapshot } from '@/dealer-network/dealer-network';
import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import { buildMaterialEarningsReport } from '@/referrals/referral-report';
import { buildNetworkProfitBreakdown } from './network-profit-breakdown';
import { presentApiResponse } from './response-privacy.interceptor';

type Mode = 'INTERNAL' | 'EXTERNAL';

function fixture(rootMode: Mode = 'EXTERNAL', subMode: Mode = 'EXTERNAL', ownerId = 3): any {
  const nodes: NetworkSnapshot['nodes'] = [
    { id: 11, username: 'Saved grandparent', level: 'DEALER', markup: '0', mode: rootMode },
    { id: 12, username: 'Saved parent', level: 'SUBDEALER', markup: '0.3', mode: subMode },
    { id: 13, username: 'Saved distributor', level: 'DISTRIBUTOR', markup: '0.153846153846153846', mode: 'EXTERNAL' },
  ].slice(0, ownerId) as NetworkSnapshot['nodes'];
  const firstExternal = nodes.findIndex(node => node.mode === 'EXTERNAL');
  const billingIndex = firstExternal < 0 ? nodes.length : firstExternal;
  const customer = ownerId === 3 ? '1800.00' : '1560.00';
  const ownerPrice = ownerId === 3 ? '1500.00' : '1300.00';
  const prices = ownerId === 3 ? ['1000.00', '1300.00', ownerPrice, customer]
    : ['1000.00', ownerPrice, customer];
  const owner = nodes.at(-1)!;
  const network: NetworkSnapshot = {
    version: 1, rootMode, rootMarkup: '0.25', nodes,
    payerType: firstExternal < 0 ? 'CUSTOMER' : 'ACCOUNT_OWNER', billingIndex,
    billingAccountId: nodes[Math.min(billingIndex, nodes.length - 1)].id,
    billingTaxRate: '0.07', payer: { name: 'Billing account', email: null, phone: null },
    subdealerPlan: subMode === 'INTERNAL' ? { mode: 'AVAILABLE_PROFIT', percent: '50' } : null,
    earningsPlan: rootMode === 'INTERNAL' ? {
      version: 2, planId: 1, revision: 1, name: 'Frozen root plan', basis: 'DEALER_MARKUP', percent: '50',
    } : null,
  };
  return {
    id: 71, number: '191071', idUser: owner.id, units: 1, status: { name: 'Active' },
    user: { id: owner.id, username: 'Current account name', idRole: 2, role: { name: 'dealer' },
      dealerMode: owner.mode, parentDealerId: nodes.at(-2)!.id },
    dealerModeSnapshot: owner.mode, dealerNetworkSnapshot: network,
    networkRootPriceT: prices[0], networkSubdealerPriceT: prices[1], networkBillingPriceT: prices[billingIndex],
    rateT: '800.00', priceT: ownerPrice, customerPriceT: customer,
    totalPayable: new Decimal(ownerPrice).mul('1.07').toFixed(2), taxRate: '0.07',
    customerTotalPayable: new Decimal(customer).mul('1.07').toFixed(2), customerTaxRate: '0.07',
    materialProcessingCost: '0.00', materialProcessingCostPending: false,
    pieces: [{ qty: 1, rate: '800.00', networkPricing: { version: 1, billingIndex, prices, regularPrices: prices } }],
    installationJob: null, customerCharges: [], payments: [], order: null, materialRevisions: [],
  };
}

function addInstallation(estimate: any, options: { provider?: string | null; sale?: string; addition?: string } = {}) {
  const sale = options.sale ?? '600.00';
  estimate.installationJob = {
    id: 7, status: 'REQUESTED', permit: null,
    quotes: [{ id: 17, version: 1, status: 'DRAFT', total: sale, needsRecalculation: false,
      lines: [], serviceMinimumsSnapshot: [], installationSurcharge: '0.00',
      providerCostSnapshot: options.provider === null ? null : { schema: 1, total: options.provider ?? '500.00' } }],
  };
  if (options.addition !== '0.00') {
    estimate.customerCharges = [{ id: 1, origin: 'SYSTEM', source: 'INSTALLATION', sourceKey: 'INSTALLATION',
      sourceRefId: null, description: 'Installation', pricingMode: 'AMOUNT', pricingValue: options.addition ?? '150.00',
      usedInCustomerQuote: true, systemAmountSnapshot: sale, sortOrder: 10 }];
  }
  return estimate.installationJob.quotes[0];
}

const calculated = (amount: string) => ({ amount, status: 'CALCULATED' });
const actor = (role: string | undefined, id = 99): any => role ? { id, role: { name: role } } : undefined;
const member = (report: NonNullable<ReturnType<typeof buildNetworkProfitBreakdown>>, id: number) =>
  report.members.find(row => row.userId === id)!;

describe('Administrator network profit breakdown', () => {
  it.each([
    ['EXTERNAL', 'EXTERNAL', null, '300.00', '200.00', '300.00', '200.00'],
    ['INTERNAL', 'EXTERNAL', null, '150.00', '200.00', '300.00', '350.00'],
    ['INTERNAL', 'INTERNAL', 'AVAILABLE_PROFIT', '125.00', '125.00', '300.00', '450.00'],
    ['INTERNAL', 'INTERNAL', 'MARKUP', '150.00', '200.00', '300.00', '350.00'],
  ] as const)('reports all material participants for %s/%s/%s without duplicating margins',
    (rootMode, subMode, mode, dealer, subdealer, distributor, company) => {
      const estimate = fixture(rootMode, subMode);
      if (mode) estimate.dealerNetworkSnapshot.subdealerPlan = { mode, percent: mode === 'MARKUP' ? '100' : '50' };
      const report = buildNetworkProfitBreakdown(estimate)!;
      expect(report.version).toBe(1);
      expect(report.members.map(row => [row.userId, row.level, row.username])).toEqual([
        [13, 'DISTRIBUTOR', 'Saved distributor'], [12, 'SUBDEALER', 'Saved parent'], [11, 'DEALER', 'Saved grandparent'],
      ]);
      expect(member(report, 11).material).toEqual(calculated(dealer));
      expect(member(report, 12).material).toEqual(calculated(subdealer));
      expect(member(report, 13).material).toEqual(calculated(distributor));
      expect(report.company.materialExpected).toEqual(calculated(company));
      expect(report.company.materialReal).toMatchObject({ amount: null, status: 'PENDING_REAL_COST' });
      expect(report.company.installation).toEqual(calculated('0.00'));
      expect(report.company.expectedTotal).toEqual(calculated(company));
      const distributedProfit = report.members.reduce((sum, row) => sum.add(row.total.amount!), new Decimal(company));
      expect(distributedProfit.toFixed(2)).toBe('1000.00');
    });

  it.each([
    ['EXTERNAL', 'EXTERNAL', '400.00', '200.00', '300.00', '100.00'],
    ['INTERNAL', 'EXTERNAL', '100.00', '300.00', '300.00', '300.00'],
    ['INTERNAL', 'INTERNAL', '100.00', '100.00', '400.00', '400.00'],
  ] as const)('assigns a material discount only to the billed external account in %s/%s',
    (rootMode, subMode, dealer, subdealer, distributor, company) => {
      const estimate = fixture(rootMode, subMode);
      estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
      const report = buildNetworkProfitBreakdown(estimate)!;
      expect(member(report, 11).material).toEqual(calculated(dealer));
      expect(member(report, 12).material).toEqual(calculated(subdealer));
      expect(member(report, 13).material).toEqual(calculated(distributor));
      expect(report.company.materialExpected).toEqual(calculated(company));
    });

  it('does not apply the material discount twice after an order records its net sale', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
    estimate.order = { saleSubtotal: '1400.00', rate: '800.00', rateReal: '750.00' };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 11).material).toEqual(calculated('100.00'));
    expect(member(report, 12).material).toEqual(calculated('100.00'));
    expect(member(report, 13).material).toEqual(calculated('400.00'));
    expect(report.company.materialExpected).toEqual(calculated('400.00'));
    expect(report.company.materialReal).toEqual(calculated('450.00'));
  });

  it('handles a two-level internal network without fabricating a distributor', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL', 2);
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.members.map(row => row.level)).toEqual(['SUBDEALER', 'DEALER']);
    expect(member(report, 11).material).toEqual(calculated('140.00'));
    expect(member(report, 12).material).toEqual(calculated('140.00'));
    expect(report.company.materialExpected).toEqual(calculated('480.00'));
  });

  it('preserves negative margins instead of replacing losses with zero', () => {
    const estimate = fixture();
    estimate.customerPriceT = '1400.00';
    estimate.rateT = '1200.00';
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).material).toEqual(calculated('-100.00'));
    expect(member(report, 13).total).toEqual(calculated('-100.00'));
    expect(report.company.materialExpected).toEqual(calculated('-200.00'));
  });

  it('preserves the saved participants and plans when current account terms change', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    const expected = buildNetworkProfitBreakdown(estimate);
    Object.assign(estimate.user, { username: 'Renamed account', dealerMode: 'INTERNAL', networkMarkup: '0.90',
      subdealerEarningsPercent: '90', dealerEarningsPlan: { basis: 'EXPECTED_PROFIT', percent: '99' } });
    const before = JSON.stringify(estimate);
    expect(buildNetworkProfitBreakdown(estimate)).toEqual(expected);
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('keeps material earnings pending until the real factory cost is known', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.dealerNetworkSnapshot.earningsPlan.basis = 'REAL_PROFIT';
    const report = buildNetworkProfitBreakdown(estimate)!;
    for (const id of [11, 12]) {
      expect(member(report, id).material).toEqual({ amount: null, status: 'PENDING_REAL_COST' });
      expect(member(report, id).total.amount).toBeNull();
    }
    expect(member(report, 13).material).toEqual(calculated('300.00'));
    expect(report.company.materialExpected.amount).toBeNull();
    expect(report.company.expectedTotal.amount).toBeNull();
  });

  it('knows a MARKUP subdealer amount while the root real-profit plan is still pending', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.dealerNetworkSnapshot.earningsPlan.basis = 'REAL_PROFIT';
    estimate.dealerNetworkSnapshot.subdealerPlan = { mode: 'MARKUP', percent: '100' };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 11).material.amount).toBeNull();
    expect(member(report, 12).material).toEqual(calculated('200.00'));
  });

  it('keeps real-profit shares pending when material processing fees await confirmation', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.dealerNetworkSnapshot.earningsPlan.basis = 'REAL_PROFIT';
    estimate.order = { saleSubtotal: '1500.00', rate: '800.00', rateReal: '700.00' };
    estimate.materialProcessingCostPending = true;
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 11).material).toEqual({ amount: null, status: 'PENDING_COST' });
    expect(member(report, 12).material).toEqual({ amount: null, status: 'PENDING_COST' });
    expect(report.company.materialReal).toEqual({ amount: null, status: 'PENDING_COST' });
  });

  it('uses reconciled material processing cost exactly once in company real profit', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.order = { saleSubtotal: '1500.00', rate: '800.00', rateReal: '700.00' };
    estimate.materialProcessingCost = '30.00';
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.materialExpected).toEqual(calculated('450.00'));
    expect(report.company.materialReal).toEqual(calculated('520.00'));
  });

  it('uses the existing company financial report after referral liability', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    estimate.order = { id: 1, idEst: 71, status: { name: 'Pending' }, saleSubtotal: '1500.00', rate: '800.00', rateReal: '700.00',
      referralReward: { terms: { version: 1, mode: 'CUSTOM_PERCENT', percent: '20' } } };
    const financials = buildMaterialEarningsReport(estimate);
    expect(financials.materialProfits?.authenticExpectedProfit).toBe('310.00');
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.materialExpected).toEqual(calculated('310.00'));
    expect(report.company.materialReal).toEqual(calculated('410.00'));
    expect(member(report, 11).material).toEqual(calculated('125.00'));
  });

  it('returns no hierarchy for an estimate without a saved dealer network', () => {
    const estimate = fixture();
    estimate.dealerNetworkSnapshot = null;
    expect(buildNetworkProfitBreakdown(estimate)).toBeNull();
  });
});

describe('Network installation and service margins', () => {
  it('assigns service increases and custom charges to the owner once, apart from company profile profit', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.customerCharges.push({ id: 2, origin: 'DEALER', source: 'CUSTOM', sourceKey: null,
      description: 'Additional customer request', pricingMode: 'FINAL', pricingValue: '40.00', sortOrder: 20 });
    const before = JSON.stringify(estimate);
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual(calculated('190.00'));
    expect(member(report, 13).total).toEqual(calculated('490.00'));
    expect(member(report, 11).services).toEqual(calculated('0.00'));
    expect(member(report, 12).services).toEqual(calculated('0.00'));
    expect(report.company.installation).toEqual(calculated('100.00'));
    expect(report.company.expectedTotal).toEqual(calculated('300.00'));
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it.each([
    ['EXTERNAL', 'EXTERNAL', 11], ['INTERNAL', 'EXTERNAL', 12], ['INTERNAL', 'INTERNAL', 13],
  ] as const)('assigns installation discount to billing account %s/%s, not automatically the owner', (root, sub, billedId) => {
    const estimate = fixture(root, sub);
    addInstallation(estimate);
    estimate.manualDiscount = { scope: 'INSTALLATION', type: 'AMOUNT', value: '20.00' };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual(calculated(billedId === 13 ? '170.00' : '150.00'));
    for (const id of [11, 12]) expect(member(report, id).services).toEqual(calculated(id === billedId ? '20.00' : '0.00'));
    expect(report.company.installation).toEqual(calculated('80.00'));
  });

  it('keeps an internal owner increase intact when the customer receives an installation discount', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL', 2);
    addInstallation(estimate);
    estimate.manualDiscount = { scope: 'INSTALLATION', type: 'AMOUNT', value: '20.00' };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 12).services).toEqual(calculated('150.00'));
    expect(member(report, 11).services).toEqual(calculated('0.00'));
    expect(report.company.installation).toEqual(calculated('80.00'));
  });

  it('does not count provider minimums and coverage as a second company margin', () => {
    const estimate = fixture();
    const quote = addInstallation(estimate, { provider: '550.00', sale: '610.00', addition: '0.00' });
    quote.installationSurcharge = '50.00';
    quote.providerCostSnapshot = { schema: 1, total: '550.00', baseSubtotal: '300.00',
      serviceMinimumAdjustment: '0.00', minimumAdjustment: '200.00', installationSurcharge: '50.00' };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.installation).toEqual(calculated('60.00'));
    expect(member(report, 13).services).toEqual(calculated('0.00'));
  });

  it('uses the approved installation price and provider cost when a newer revision was rejected', () => {
    const estimate = fixture();
    const approved = addInstallation(estimate);
    approved.status = 'APPROVED';
    estimate.customerCharges[0].pricingMode = 'PERCENTAGE';
    estimate.customerCharges[0].pricingValue = '25.00';
    estimate.installationJob.quotes = [{ ...approved, id: 18, version: 2, status: 'REJECTED',
      total: '1000.00', needsRecalculation: true, providerCostSnapshot: { schema: 1, total: '300.00' } }, approved];
    estimate.manualDiscount = { scope: 'INSTALLATION', type: 'PERCENTAGE', value: '10.00' };
    const before = JSON.stringify(estimate);
    const report = buildNetworkProfitBreakdown(estimate)!;
    // The valid sale is 600, its supplier cost is 500, and its discount is 60.
    expect(report.company.installation).toEqual(calculated('40.00'));
    expect(report.company.expectedTotal).toEqual(calculated('240.00'));
    expect(member(report, 13).services).toEqual(calculated('150.00'));
    expect(member(report, 13).total).toEqual(calculated('450.00'));
    expect(member(report, 11).services).toEqual(calculated('60.00'));
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('keeps historical installation provider cost unknown instead of assuming zero', () => {
    const estimate = fixture();
    addInstallation(estimate, { provider: null });
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.installation).toEqual({ amount: null, status: 'PENDING_REVIEW' });
    expect(report.company.expectedTotal.amount).toBeNull();
    expect(member(report, 13).services).toEqual(calculated('150.00'));
  });

  it('accepts a known zero provider cost while rejecting an unsupported snapshot', () => {
    const estimate = fixture();
    const quote = addInstallation(estimate, { provider: '0.00' });
    expect(buildNetworkProfitBreakdown(estimate)!.company.installation).toEqual(calculated('600.00'));
    quote.providerCostSnapshot.schema = 9;
    expect(buildNetworkProfitBreakdown(estimate)!.company.installation).toEqual({ amount: null, status: 'PENDING_REVIEW' });
  });

  it('preserves a company installation loss when the discount exceeds its profile increase', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.manualDiscount = { scope: 'INSTALLATION', type: 'AMOUNT', value: '200.00' };
    expect(buildNetworkProfitBreakdown(estimate)!.company.installation).toEqual(calculated('-100.00'));
  });

  it('does not publish a final margin for installation waiting to be recalculated', () => {
    const estimate = fixture();
    const quote = addInstallation(estimate);
    quote.needsRecalculation = true;
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.installation).toEqual({ amount: null, status: 'PENDING_REVIEW' });
    expect(report.company.expectedTotal.amount).toBeNull();
    expect(member(report, 13).services.amount).toBeNull();
  });

  it('keeps service margin pending when saved pricing is based on an obsolete system amount', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.customerCharges[0].systemAmountSnapshot = '500.00';
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual({ amount: null, status: 'PENDING_REVIEW' });
    expect(member(report, 13).total.amount).toBeNull();
    expect(report.company.installation).toEqual(calculated('100.00'));
  });

  it('does not hide an unknown city fee inside a calculated owner service total', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.installationJob.permit = { permitFeeSnapshot: '50.00', cityFee: null };
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual({ amount: null, status: 'PENDING_REVIEW' });
    expect(member(report, 11).services).toEqual(calculated('0.00'));
    expect(report.company.installation).toEqual(calculated('100.00'));
  });

  it('preserves the external owner cost when installation is omitted from the customer quote', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.customerCharges[0].usedInCustomerQuote = false;
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual(calculated('-600.00'));
    expect(report.company.installation).toEqual(calculated('100.00'));
  });

  it('keeps custom dealer services when no company installation is included', () => {
    const estimate = fixture();
    estimate.customerCharges = [{ id: 2, origin: 'DEALER', source: 'CUSTOM', sourceKey: null,
      description: 'Separate service', pricingMode: 'FINAL', pricingValue: '75.00', sortOrder: 20 }];
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(member(report, 13).services).toEqual(calculated('75.00'));
    expect(report.company.installation).toEqual(calculated('0.00'));
  });

  it('does not include a canceled installation or its system override as current profit', () => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.installationJob.status = 'CANCELED';
    const report = buildNetworkProfitBreakdown(estimate)!;
    expect(report.company.installation).toEqual(calculated('0.00'));
    expect(member(report, 13).services).toEqual(calculated('0.00'));
  });
});

describe('Network profit privacy', () => {
  it.each(['dealer', 'operator', 'client', 'technician', undefined])('does not expose the new breakdown at any response depth to %s', role => {
    const estimate = fixture();
    const report = buildNetworkProfitBreakdown(estimate)!;
    const payload = { ...estimate, networkProfitBreakdown: report,
      nested: { networkProfitBreakdown: report }, rows: [{ networkProfitBreakdown: report }] };
    const result = presentApiResponse(payload, actor(role, 13));
    expect(result).not.toHaveProperty('networkProfitBreakdown');
    expect(result.nested).not.toHaveProperty('networkProfitBreakdown');
    expect(result.rows[0]).not.toHaveProperty('networkProfitBreakdown');
    if (role === 'dealer') expect(result.dealerNetwork.materialProfit).toBe('300.00');
  });

  it('preserves the complete breakdown for the administrator', () => {
    const estimate = fixture('INTERNAL', 'INTERNAL');
    const report = buildNetworkProfitBreakdown(estimate)!;
    const result = presentApiResponse({ ...estimate, networkProfitBreakdown: report }, actor('admin'));
    expect(result.networkProfitBreakdown).toEqual(report);
  });

  it.each(['detailed', 'total'] as const)('keeps the %s public customer report free of the breakdown', mode => {
    const estimate = fixture();
    addInstallation(estimate);
    estimate.networkProfitBreakdown = buildNetworkProfitBreakdown(estimate);
    const result = buildPublicEstimateData(estimate, { name: 'Dealer brand' }, [], mode);
    expect(result).not.toHaveProperty('networkProfitBreakdown');
    expect(JSON.stringify(result)).not.toContain('Saved grandparent');
    expect(JSON.stringify(result)).not.toContain('providerCostSnapshot');
  });
});

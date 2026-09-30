import Decimal from 'decimal.js';
import type { DealerEarningsBasis } from '@prisma/client';
import { buildDealerEarningsReport } from './dealer-earnings';
import { presentApiResponse } from './response-privacy.interceptor';

function estimate(basis: DealerEarningsBasis = 'REAL_PROFIT', mode: 'AVAILABLE_PROFIT' | 'MARKUP' = 'AVAILABLE_PROFIT'): any {
  return {
    id: 1, idUser: 2, dealerModeSnapshot: 'INTERNAL',
    rateT: '118.01', priceT: '177.02', customerPriceT: '221.28', netProfitD: '44.26',
    networkBillingPriceT: '221.28', networkRootPriceT: '118.01', networkSubdealerPriceT: '177.02',
    taxRate: '0', totalPayable: '177.02', customerTaxRate: '0', customerTotalPayable: '221.28',
    materialProcessingCost: '5.00', materialProcessingCostPending: false,
    order: { saleSubtotal: '221.28', rate: '118.01', rateReal: '90.02' },
    pieces: [], payments: [], installationJob: null,
    dealerNetworkSnapshot: {
      version: 1, rootMode: 'INTERNAL', rootMarkup: '0',
      nodes: [
        { id: 1, username: 'parent', level: 'DEALER', markup: '0', mode: 'INTERNAL' },
        { id: 2, username: 'child', level: 'SUBDEALER', markup: '0.5', mode: 'INTERNAL' },
      ],
      payerType: 'CUSTOMER', billingIndex: 2, billingAccountId: 2, billingTaxRate: '0',
      payer: { name: 'Customer', email: null, phone: null },
      subdealerPlan: { mode, percent: mode === 'MARKUP' ? '100' : '40' },
      earningsPlan: { version: 2, planId: 12, name: 'Saved plan', revision: 1, basis, percent: '50' },
    },
  };
}

function expectConserved(report: ReturnType<typeof buildDealerEarningsReport>) {
  const earnings = new Decimal(report.dealerEarnings?.amount ?? 0).plus(report.subdealerEarnings?.amount ?? 0);
  expect(earnings.plus(report.materialProfits!.authenticRealProfit!).toFixed(2)).toBe(report.materialProfits!.netRealProfit);
}

describe('Material processing costs in earnings', () => {
  it('deducts the material cost before REAL_PROFIT and shares that participation only once', () => {
    const e = estimate();
    const before = JSON.stringify(e);
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ amount: '37.88', status: 'CALCULATED' });
    expect(report.subdealerEarnings).toMatchObject({ amount: '25.25', status: 'CALCULATED' });
    expect(report.materialProfits).toMatchObject({ realProfit: '131.26', processingCost: '5.00',
      processingCostStatus: 'CONFIRMED', netRealProfit: '126.26', authenticRealProfit: '63.13' });
    expectConserved(report);
    expect(JSON.stringify(e)).toBe(before);
  });

  it.each([
    ['EXPECTED_PROFIT', '30.98', '20.66', '74.62'],
    ['DEALER_MARKUP', '30.98', '20.66', '74.62'],
  ] as const)('preserves %s earnings but always reduces company real profit', (basis, parent, child, company) => {
    const report = buildDealerEarningsReport(estimate(basis));
    expect(report.dealerEarnings?.amount).toBe(parent);
    expect(report.subdealerEarnings?.amount).toBe(child);
    expect(report.materialProfits?.authenticRealProfit).toBe(company);
    expectConserved(report);
  });

  it('preserves the full MARKUP child share while reducing a REAL_PROFIT parent', () => {
    const report = buildDealerEarningsReport(estimate('REAL_PROFIT', 'MARKUP'));
    expect(report.dealerEarnings?.amount).toBe('41.00');
    expect(report.subdealerEarnings?.amount).toBe('44.26');
    expect(report.materialProfits?.authenticRealProfit).toBe('41.00');
    expectConserved(report);
  });

  it.each(['EXPECTED_PROFIT', 'DEALER_MARKUP'] as const)('preserves all MARKUP distribution for parent basis %s', basis => {
    const e = estimate(basis, 'MARKUP');
    const report = buildDealerEarningsReport(e);
    e.materialProcessingCost = '0';
    const previous = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toEqual(previous.dealerEarnings);
    expect(report.subdealerEarnings).toEqual(previous.subdealerEarnings);
    expect(new Decimal(previous.materialProfits!.authenticRealProfit!).minus('5').toFixed(2)).toBe(report.materialProfits!.authenticRealProfit);
  });

  it('uses a generic pending status for both REAL_PROFIT participants when processing cost is unconfirmed', () => {
    const e = estimate(); e.materialProcessingCostPending = true;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ amount: null, status: 'PENDING_COST' });
    expect(report.subdealerEarnings).toMatchObject({ amount: null, status: 'PENDING_COST' });
    expect(report.materialProfits).toMatchObject({ realProfit: '131.26', processingCost: null,
      processingCostStatus: 'PENDING', netRealProfit: null, authenticRealProfit: null });
  });

  it('keeps the independent MARKUP child visible while REAL_PROFIT costs are pending', () => {
    const e = estimate('REAL_PROFIT', 'MARKUP'); e.materialProcessingCostPending = true;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ amount: null, status: 'PENDING_COST' });
    expect(report.subdealerEarnings).toMatchObject({ amount: '44.26', status: 'CALCULATED' });
    expect(report.materialProfits?.authenticRealProfit).toBeNull();
  });

  it.each(['EXPECTED_PROFIT', 'DEALER_MARKUP'] as const)('does not block %s earnings for a pending processing cost', basis => {
    const e = estimate(basis); e.materialProcessingCostPending = true;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ amount: '30.98', status: 'CALCULATED' });
    expect(report.subdealerEarnings).toMatchObject({ amount: '20.66', status: 'CALCULATED' });
    expect(report.materialProfits?.authenticRealProfit).toBeNull();
  });

  it('keeps missing factory cost pending after processing cost is confirmed', () => {
    const e = estimate(); e.order.rateReal = null;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ amount: null, status: 'PENDING_REAL_COST' });
    expect(report.materialProfits).toMatchObject({ realProfit: null, netRealProfit: null, processingCost: '5.00' });
  });

  it('leaves historic distributions unchanged when cost fields are absent', () => {
    const e = estimate(); delete e.materialProcessingCost; delete e.materialProcessingCostPending;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings?.amount).toBe('39.38');
    expect(report.subdealerEarnings?.amount).toBe('26.25');
    expect(report.materialProfits).toMatchObject({ processingCost: '0.00', authenticRealProfit: '65.63' });
  });

  it('applies cost to external-network company profit without introducing dealer earnings', () => {
    const e = estimate(); e.dealerNetworkSnapshot.rootMode = 'EXTERNAL';
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toBeNull(); expect(report.subdealerEarnings).toBeNull();
    expect(report.materialProfits).toMatchObject({ realProfit: '131.26', netRealProfit: '126.26', authenticRealProfit: '126.26' });
  });

  it('uses net factory profit for a direct internal dealer without a network', () => {
    const e = estimate(); e.dealerEarningsPlanSnapshot = e.dealerNetworkSnapshot.earningsPlan;
    delete e.dealerNetworkSnapshot;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings?.amount).toBe('63.13');
    expect(report.materialProfits?.authenticRealProfit).toBe('63.13');
    expectConserved(report);
  });

  it.each([null, 'EXTERNAL'])('exposes company net profit for direct mode %s only when new costs apply', mode => {
    const e = estimate(); delete e.dealerNetworkSnapshot; e.dealerModeSnapshot = mode;
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toBeNull();
    expect(report.materialProfits).toMatchObject({ realProfit: '131.26', authenticRealProfit: '126.26' });
    e.materialProcessingCost = '0';
    expect(buildDealerEarningsReport(e)).toEqual({ dealerEarnings: null, materialProfits: null });
    e.materialProcessingCostPending = true;
    expect(buildDealerEarningsReport(e).materialProfits).toMatchObject({ processingCostStatus: 'PENDING', authenticRealProfit: null });
  });

  it('does not subtract receipt surcharges or nonmaterial costs a second time', () => {
    const e = estimate(); e.payments = [{ surchargeAmount: '12', processingCostSnapshot: { installation: '99' } }];
    e.processingCosts = [{ fee: '100', materialFee: '5', materialSurcharge: '0' }];
    expect(buildDealerEarningsReport(e).materialProfits?.netRealProfit).toBe('126.26');
  });

  it('retains signed net costs when collected surcharges exceed the allocated fee', () => {
    const e = estimate(); e.materialProcessingCost = '-5.00';
    const report = buildDealerEarningsReport(e);
    expect(report.materialProfits?.netRealProfit).toBe('136.26');
    expectConserved(report);
  });
});

describe('Processing cost privacy', () => {
  const secret = {
    processingCostSnapshot: { material: '11.00' }, processingCosts: [{ fee: '7' }],
    processingCostSummary: { fee: '7' }, materialProcessingCost: '5.00', materialProcessingCostPending: true,
    processingCost: '5.00', processingCostStatus: 'PENDING', netRealProfit: '126.26',
    materialFee: '6.00', materialSurcharge: '1.00', balanceTransactionId: 'txn_private',
    allocationSnapshot: { material: '5.00' }, capturedAmount: '221.28',
  };

  it.each([undefined, 'client', 'technician', 'dealer'])('removes all cost fields recursively for %s', role => {
    const e = estimate(); e.materialProcessingCostPending = true;
    const payload = { ...e, ...buildDealerEarningsReport(e), ...secret, nested: [{ ...secret, safe: 'yes' }] };
    const result = presentApiResponse(payload, role ? { id: 2, role: { name: role } } as any : undefined);
    for (const key of Object.keys(secret)) {
      expect(result).not.toHaveProperty(key);
      expect(result.nested[0]).not.toHaveProperty(key);
    }
    expect(result.nested[0].safe).toBe('yes');
    expect(result).not.toHaveProperty('materialProfits');
    if (role === 'dealer') expect(result.dealerEarnings).toMatchObject({ amount: null, status: 'PENDING_COST' });
  });

  it.each(['admin', 'operator'])('preserves company cost reporting for %s', role => {
    const payload = { ...estimate(), ...secret };
    const result = presentApiResponse(payload, { id: 1, role: { name: role } } as any);
    expect(result.processingCostSnapshot).toEqual(secret.processingCostSnapshot);
    expect(result.materialProcessingCost).toBe('5.00');
  });
});

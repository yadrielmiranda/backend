import { DealerEarningsBasis } from '@prisma/client';
import { EarningsPlanSnapshot, validateEarningsRule } from '@/earnings-plans/earnings-plan';
import { calculateMaterialProfitBases } from './material-profit-bases';
import { buildDealerEarningsReport, calculateDealerEarnings } from './dealer-earnings';
import { presentApiResponse } from './response-privacy.interceptor';
import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';

const plan = (basis: DealerEarningsBasis, percent: string | number): EarningsPlanSnapshot => ({
  version: 2, planId: 12, name: 'Sales team', revision: 1, basis, percent: String(percent),
});

const estimate = (basis: DealerEarningsBasis = 'EXPECTED_PROFIT', percent = '20'): any => ({
  id: 1, dealerModeSnapshot: 'INTERNAL',
  rateT: '1000', priceT: '1200', customerPriceT: '1500', netProfitD: '300',
  taxRate: '0.07', taxAmount: '84', totalPayable: '1284',
  customerTaxRate: '0.07', customerTaxAmount: '105', customerTotalPayable: '1605',
  dealerEarningsPlanSnapshot: plan(basis, percent),
  user: { id: 1, username: 'dealer', idRole: 2, role: { name: 'dealer' } },
  pieces: [], payments: [], installationJob: null,
});

describe('Internal dealer material earnings', () => {
  it('keeps app base, Dealer Price and factory cost as three different inputs', () => {
    const profits = calculateMaterialProfitBases({ customerPrice: 1500, appBasePrice: 1000, dealerPrice: 1200, realFactoryCost: 900 });
    expect(profits.expectedProfit.toFixed(2)).toBe('500.00');
    expect(profits.realProfit?.toFixed(2)).toBe('600.00');
    expect(profits.netProfitD.toFixed(2)).toBe('300.00');
    expect(calculateDealerEarnings(plan('EXPECTED_PROFIT', 20), profits).amount).toBe('100.00');
    expect(calculateDealerEarnings(plan('REAL_PROFIT', 20), profits).amount).toBe('120.00');
    expect(calculateDealerEarnings(plan('DEALER_MARKUP', '100'), profits).amount).toBe('300.00');
  });

  it.each([
    ['EXPECTED_PROFIT', '20', '100.00', '400.00', '500.00'],
    ['REAL_PROFIT', '20', '120.00', '380.00', '480.00'],
    ['DEALER_MARKUP', '100', '300.00', '200.00', '300.00'],
  ] as const)('applies %s once and excludes tax and services', (basis, percent, amount, expected, real) => {
    const e = estimate(basis, percent);
    e.order = { saleSubtotal: '1500', rate: '1000', rateReal: '900', dealerModeSnapshot: 'INTERNAL' };
    e.installationJob = { status: 'APPROVED', quotes: [{ status: 'APPROVED', total: '4000' }] };
    const before = JSON.stringify(e);
    const result = buildDealerEarningsReport(e);
    expect(result.dealerEarnings?.amount).toBe(amount);
    expect(result.materialProfits).toMatchObject({ expectedProfit: '500.00', realProfit: '600.00', authenticExpectedProfit: expected, authenticRealProfit: real });
    expect(JSON.stringify(e)).toBe(before);
  });

  it('keeps real earnings pending until actual cost exists, including a valid zero cost', () => {
    const e = estimate('REAL_PROFIT');
    expect(buildDealerEarningsReport(e).dealerEarnings).toMatchObject({ status: 'PENDING_REAL_COST', amount: null });
    expect(buildDealerEarningsReport(e).materialProfits?.authenticExpectedProfit).toBeNull();
    e.order = { rate: '1000', saleSubtotal: '1500', rateReal: '0' };
    expect(buildDealerEarningsReport(e).dealerEarnings).toMatchObject({ status: 'CALCULATED', amount: '300.00' });
  });

  it('applies material discounts before earnings and does not count the tax reduction', () => {
    const e = estimate('DEALER_MARKUP', '100');
    e.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('200.00');
    expect(buildDealerEarningsReport(e).materialProfits?.expectedProfit).toBe('400.00');
    e.dealerEarningsPlanSnapshot = plan('EXPECTED_PROFIT', 20);
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('80.00');
    // La orden ya contiene el descuento; no se descuenta por segunda vez.
    e.order = { saleSubtotal: '1400', rate: '1000', rateReal: '900' };
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('80.00');
    expect(buildDealerEarningsReport(e).materialProfits?.realProfit).toBe('500.00');
  });

  it('does not reduce material earnings for an installation-only discount', () => {
    const e = estimate();
    e.installationJob = { status: 'APPROVED', quotes: [{ status: 'APPROVED', total: '4000' }] };
    e.manualDiscount = { scope: 'INSTALLATION', type: 'AMOUNT', value: '500' };
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('100.00');
  });

  it('uses the saved sale plan even if the account now has a different plan', () => {
    const e = estimate();
    Object.assign(e.user, { dealerEarningsPlanId: 95, dealerEarningsPlan: { basis: 'REAL_PROFIT', percent: '95' } });
    e.order = { saleSubtotal: '1500', rate: '1000', rateReal: '900' };
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('100.00');
  });

  it('keeps a completed sale at 25 percent after the dealer changes to 30 percent', () => {
    const e = estimate('EXPECTED_PROFIT', '25');
    e.order = { saleSubtotal: '1500', rate: '1000', rateReal: '900' };
    e.user.dealerEarningsPlan = { id: 95, name: 'Current 30%', basis: 'EXPECTED_PROFIT', percent: '30' };
    const saved = JSON.stringify(e);
    expect(buildDealerEarningsReport(e).dealerEarnings).toMatchObject({ percent: '25', amount: '125.00' });
    expect(JSON.stringify(e)).toBe(saved);
  });

  it.each([null, { saleSubtotal: '1500', rate: '1000', rateReal: '900' }])('keeps pre-plan operations at zero despite a later assigned plan, order=%j', order => {
    const e = estimate('DEALER_MARKUP', '0');
    e.dealerEarningsPlanSnapshot = { ...e.dealerEarningsPlanSnapshot, planId: null, revision: null, name: 'No earnings plan assigned' };
    e.user.dealerEarningsPlan = { id: 95, name: 'Markup total', basis: 'DEALER_MARKUP', percent: '100' };
    e.order = order;
    const saved = JSON.stringify(e);
    const report = buildDealerEarningsReport(e);
    expect(report.dealerEarnings).toMatchObject({ planId: null, percent: '0', amount: '0.00', status: 'CALCULATED' });
    expect(report.materialProfits?.authenticExpectedProfit).toBe('500.00');
    expect(JSON.stringify(e)).toBe(saved);
  });

  it('uses stored order amounts and resolves the real plan when factory cost arrives', () => {
    const e = estimate('REAL_PROFIT');
    e.order = { saleSubtotal: '1400', rate: '900', rateReal: null };
    expect(buildDealerEarningsReport(e).materialProfits?.expectedProfit).toBe('500.00');
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBeNull();
    e.order.rateReal = '800';
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('120.00');
    expect(e.dealerEarningsPlanSnapshot.percent).toBe('20');
  });

  it('reuses netProfitD and preserves losses instead of silently clamping the formula', () => {
    const profits = calculateMaterialProfitBases({ customerPrice: '899.99', appBasePrice: '1000', dealerPrice: '1200', realFactoryCost: '900', netProfitD: '-300.00' });
    expect(calculateDealerEarnings(plan('EXPECTED_PROFIT', '20'), profits).amount).toBe('-20.00');
    expect(calculateDealerEarnings(plan('DEALER_MARKUP', '100'), profits).amount).toBe('-300.00');
  });

  it('rounds percentages with decimal arithmetic to cents', () => {
    const profits = calculateMaterialProfitBases({ customerPrice: '100.03', appBasePrice: 100, dealerPrice: 100 });
    expect(calculateDealerEarnings(plan('EXPECTED_PROFIT', '50'), profits).amount).toBe('0.02');
  });

  it('preserves the existing markup rounding when an estimate becomes an order', () => {
    const e = { ...estimate('DEALER_MARKUP', '100'), customerPriceT: '100.00', priceT: '80.01', netProfitD: '20.00', rateT: '70' };
    expect(buildDealerEarningsReport(e).dealerEarnings?.amount).toBe('20.00');
    expect(buildDealerEarningsReport(e, { saleSubtotal: '100.00', rate: '70' }).dealerEarnings?.amount).toBe('20.00');
  });

  it.each([null, 'EXTERNAL'])('does not apply earnings to mode %s', (mode) => {
    expect(buildDealerEarningsReport({ ...estimate(), dealerModeSnapshot: mode })).toEqual({ dealerEarnings: null, materialProfits: null });
  });

  it.each(['-1', '100.0001', '101', '', 'NaN', 'Infinity', '20.12345'])('rejects invalid percentage %s', (value) => {
    expect(() => validateEarningsRule('REAL_PROFIT', value)).toThrow();
  });
  it.each(['0', '100', '20.1234'])('accepts valid percentage %s', (value) => {
    expect(validateEarningsRule('REAL_PROFIT', value).percent).toBe(value);
  });
  it('rejects an unknown plan and does not silently replace a corrupted saved plan', () => {
    expect(() => validateEarningsRule('UNKNOWN', 20)).toThrow();
    expect(() => buildDealerEarningsReport({ ...estimate(), dealerEarningsPlanSnapshot: { version: 2 } })).toThrow();
  });

  it.each([null, undefined])('rejects a missing saved plan (%s) without assuming markup or using the current account plan', value => {
    const e = estimate();
    e.dealerEarningsPlanSnapshot = value;
    Object.assign(e.user, { dealerEarningsPlanId: 95, dealerEarningsPlan: { basis: 'DEALER_MARKUP', percent: '100' } });
    expect(() => buildDealerEarningsReport(e)).toThrow('no saved earnings plan');
  });

  it.each([1, 3])('rejects snapshot version %s instead of supporting a second plan format', version => {
    const e = estimate();
    e.dealerEarningsPlanSnapshot.version = version;
    expect(() => buildDealerEarningsReport(e)).toThrow('Unsupported saved earnings plan');
  });

  it('calculates explicit saved conditions even when their original catalog entry no longer exists', () => {
    const e = estimate('REAL_PROFIT', '20');
    e.dealerEarningsPlanSnapshot.name = 'Deleted plan';
    e.user.dealerEarningsPlan = { id: 30, name: 'Current conditions', basis: 'DEALER_MARKUP', percent: '100' };
    e.order = { saleSubtotal: '1500', rate: '1000', rateReal: '900' };
    expect(buildDealerEarningsReport(e).dealerEarnings).toMatchObject({
      planId: 12, planName: 'Deleted plan', basis: 'REAL_PROFIT', percent: '20', amount: '120.00',
    });
  });

  it.each([{ planId: null }, { revision: null }, { planId: null, revision: null }, { planId: 0 }, { revision: -1 }, { name: 12 }])('rejects inconsistent saved plan metadata %j', data => {
    const e = estimate();
    Object.assign(e.dealerEarningsPlanSnapshot, data);
    expect(() => buildDealerEarningsReport(e)).toThrow('Invalid saved earnings plan');
  });

  it('keeps company bases private and removes all earnings from public/customer responses', () => {
    const e = estimate();
    const result = { ...e, ...buildDealerEarningsReport(e) };
    const dealer = presentApiResponse(result, { id: 1, role: { name: 'dealer' } } as any);
    expect(dealer.dealerEarnings.amount).toBe('100.00');
    expect(dealer).not.toHaveProperty('materialProfits');
    expect(dealer).not.toHaveProperty('rateT');
    for (const role of [undefined, 'client', 'technician']) {
      const response = presentApiResponse(result, role ? { id: 2, role: { name: role } } as any : undefined);
      expect(response).not.toHaveProperty('dealerEarnings');
      expect(response).not.toHaveProperty('dealerEarningsPlanSnapshot');
      expect(response).not.toHaveProperty('materialProfits');
    }
    for (const role of ['admin', 'operator']) {
      expect(presentApiResponse(result, { id: 2, role: { name: role } } as any).materialProfits.expectedProfit).toBe('500.00');
    }
    for (const view of ['detailed', 'total'] as const) {
      const publicData = buildPublicEstimateData(result, null, [], view);
      expect(publicData).not.toHaveProperty('dealerEarnings');
      expect(publicData).not.toHaveProperty('dealerEarningsPlanSnapshot');
      expect(publicData).not.toHaveProperty('materialProfits');
    }
  });
});

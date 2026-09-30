import Decimal from 'decimal.js';
import type { DealerEarningsBasis } from '@prisma/client';
import type { NetworkSnapshot } from '@/dealer-network/dealer-network';
import { buildDealerEarningsReport } from './dealer-earnings';

// Literal saved commercial terms and monetary inputs only. No service, database,
// environment configuration or current-plan lookup is instantiated by this spec.
function fixture({
  mode = 'AVAILABLE_PROFIT',
  basis = 'REAL_PROFIT',
  parentPercent = '50',
  childPercent = '40',
}: {
  mode?: 'AVAILABLE_PROFIT' | 'MARKUP';
  basis?: DealerEarningsBasis;
  parentPercent?: string;
  childPercent?: string;
} = {}) {
  const snapshot: NetworkSnapshot = {
    version: 1, rootMode: 'INTERNAL', rootMarkup: '0',
    nodes: [
      { id: 1, username: 'parent', level: 'DEALER', markup: '0', taxRate: '0.07', mode: 'INTERNAL' },
      { id: 2, username: 'subdealer', level: 'SUBDEALER', markup: '0.5', taxRate: '0.07', mode: 'INTERNAL' },
    ],
    payerType: 'CUSTOMER', billingIndex: 2, billingAccountId: 2,
    billingTaxRate: '0.07', payer: { name: 'Fixture customer', email: null, phone: null },
    subdealerPlan: { mode, percent: childPercent },
    earningsPlan: { version: 2, planId: 12, name: 'Gladys', revision: 1, basis, percent: parentPercent },
  };
  return {
    id: 41, dealerNetworkSnapshot: snapshot, dealerModeSnapshot: 'INTERNAL',
    rateT: '118.01', priceT: '177.02', customerPriceT: '221.28',
    networkBillingPriceT: '221.28', networkRootPriceT: '118.01', networkSubdealerPriceT: '177.02',
    taxRate: '0.07', taxAmount: '12.39', totalPayable: '189.41',
    customerTaxRate: '0.07', customerTaxAmount: '15.49', customerTotalPayable: '236.77',
    payments: [], pieces: [], installationJob: null,
    manualDiscount: null as null | { scope: 'MATERIAL'; type: 'AMOUNT'; value: string; materialDiscountBasis: 'BEFORE_TAX' },
    order: { saleSubtotal: '221.28', rate: '118.01', rateReal: '90.02' as string | null },
  };
}

type Report = ReturnType<typeof buildDealerEarningsReport>;
function expectSplit(report: Report, parent: string, child: string, companyReal: string | null, companyExpected: string) {
  expect(report.dealerEarnings).toMatchObject({ status: 'CALCULATED', amount: parent });
  expect(report.subdealerEarnings).toMatchObject({ status: 'CALCULATED', amount: child });
  expect(report.materialProfits).toMatchObject({ authenticExpectedProfit: companyExpected, authenticRealProfit: companyReal });
  // Accounting invariant independent of which earnings basis was selected.
  const parties = new Decimal(parent).plus(child);
  expect(parties.plus(companyExpected).toFixed(2)).toBe(report.materialProfits!.expectedProfit);
  if (companyReal !== null) expect(parties.plus(companyReal).toFixed(2)).toBe(report.materialProfits!.realProfit);
}

describe('AVAILABLE_PROFIT shares only the saved parent participation', () => {
  it('splits the $65.63 Gladys participation 60/40 for the reported $221.28 sale', () => {
    const estimate = fixture();
    const before = JSON.stringify(estimate);
    const report = buildDealerEarningsReport(estimate);
    expectSplit(report, '39.38', '26.25', '65.63', '37.64');
    expect(report.materialProfits).toMatchObject({ expectedProfit: '103.27', realProfit: '131.26' });
    expect(report.subdealerEarnings?.basis).toBe('AVAILABLE_PROFIT');
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('preserves MARKUP: the child receives its $44.26 resale markup separately', () => {
    const estimate = fixture({ mode: 'MARKUP', childPercent: '100' });
    expectSplit(buildDealerEarningsReport(estimate), '43.50', '44.26', '43.50', '15.51');
  });

  it('limits participation to the $221.28 billed to an external distributor, excluding its $280 resale', () => {
    const estimate = fixture();
    estimate.dealerNetworkSnapshot.nodes.push({ id: 3, username: 'distributor', level: 'DISTRIBUTOR',
      markup: '0.25', taxRate: '0.07', mode: 'EXTERNAL' });
    Object.assign(estimate.dealerNetworkSnapshot, { payerType: 'ACCOUNT_OWNER', billingAccountId: 3,
      payer: { name: 'Fixture distributor', email: null, phone: null } });
    Object.assign(estimate, { dealerModeSnapshot: 'EXTERNAL', priceT: '221.28', customerPriceT: '280.00',
      taxAmount: '15.49', totalPayable: '236.77', customerTaxAmount: '19.60', customerTotalPayable: '299.60' });
    const before = JSON.stringify(estimate);
    expectSplit(buildDealerEarningsReport(estimate), '39.38', '26.25', '65.63', '37.64');
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('uses expected profit from the billed sale for an EXPECTED_PROFIT parent plan', () => {
    expectSplit(buildDealerEarningsReport(fixture({ basis: 'EXPECTED_PROFIT' })), '30.98', '20.66', '79.62', '51.63');
  });

  it('uses the billed sale minus root price for DEALER_MARKUP, independently of app and real costs', () => {
    const estimate = fixture({ basis: 'DEALER_MARKUP' });
    estimate.networkRootPriceT = '135.50';
    expectSplit(buildDealerEarningsReport(estimate), '25.73', '17.16', '88.37', '60.38');
  });

  it.each([
    ['0', '65.63', '0.00'],
    ['100', '0.00', '65.63'],
  ])('child participation %s%% cannot change the total parent-plan allocation', (childPercent, parent, child) => {
    expectSplit(buildDealerEarningsReport(fixture({ childPercent })), parent, child, '65.63', '37.64');
  });

  it.each([
    ['0', '0.00', '0.00', '131.26', '103.27'],
    ['100', '78.76', '52.50', '0.00', '-27.99'],
  ])('parent plan %s%% does not acquire an extra resale-markup pool', (parentPercent, parent, child, real, expected) => {
    expectSplit(buildDealerEarningsReport(fixture({ parentPercent })), parent, child, real, expected);
  });

  it('assigns the rounding remainder to the parent and conserves cents', () => {
    const estimate = fixture({ childPercent: '50' });
    Object.assign(estimate, { rateT: '100.00', networkRootPriceT: '100.00', networkSubdealerPriceT: '100.02', networkBillingPriceT: '100.05' });
    estimate.order = { rate: '100.00', rateReal: '100.00', saleSubtotal: '100.05' };
    expectSplit(buildDealerEarningsReport(estimate), '0.01', '0.02', '0.02', '0.02');
  });

  it('keeps both real-profit participations pending until factory cost arrives', () => {
    const estimate = fixture(); estimate.order.rateReal = null;
    const report = buildDealerEarningsReport(estimate);
    expect(report.dealerEarnings).toMatchObject({ amount: null, status: 'PENDING_REAL_COST' });
    expect(report.subdealerEarnings).toMatchObject({ amount: null, status: 'PENDING_REAL_COST' });
    expect(report.materialProfits).toMatchObject({ realProfit: null, authenticRealProfit: null, authenticExpectedProfit: null });
    estimate.order.rateReal = '90.02';
    expectSplit(buildDealerEarningsReport(estimate), '39.38', '26.25', '65.63', '37.64');
  });

  it('uses saved terms despite current account-plan and child-percentage changes', () => {
    const estimate = Object.assign(fixture(), {
      user: { dealerEarningsPlan: { basis: 'EXPECTED_PROFIT', percent: '99' },
        subdealerEarningsMode: 'MARKUP', subdealerEarningsPercent: '100', networkMarkup: '9' },
    });
    const before = JSON.stringify(estimate);
    expectSplit(buildDealerEarningsReport(estimate), '39.38', '26.25', '65.63', '37.64');
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('applies a material discount once, before sharing, in estimate and saved-order reports', () => {
    const estimate = fixture({ basis: 'EXPECTED_PROFIT' });
    estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '10', materialDiscountBasis: 'BEFORE_TAX' };
    const unsavedOrder = { ...estimate, order: null };
    const before = JSON.stringify(unsavedOrder);
    expectSplit(buildDealerEarningsReport(unsavedOrder), '27.98', '18.66', null, '46.63');
    expect(JSON.stringify(unsavedOrder)).toBe(before);
    // The order's sale is already net of the same $10 discount.
    estimate.order.saleSubtotal = '211.28';
    expectSplit(buildDealerEarningsReport(estimate), '27.98', '18.66', '74.62', '46.63');
  });

  it('excludes taxes, installation and services from the parent-plan allocation', () => {
    const estimate = Object.assign(fixture(), {
      customerTotalPayable: '9999.00', taxAmount: '800.00',
      installationJob: { status: 'APPROVED', quotes: [{ status: 'APPROVED', total: '4000.00' }],
        permit: { permitFeeSnapshot: '700.00', cityFee: '300.00' } },
      extraCharges: [{ amount: '900.00' }],
    });
    const before = JSON.stringify(estimate);
    expectSplit(buildDealerEarningsReport(estimate), '39.38', '26.25', '65.63', '37.64');
    expect(JSON.stringify(estimate)).toBe(before);
  });
});

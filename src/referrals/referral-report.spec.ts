import { buildDealerEarningsReport } from '@/common/dealer-earnings';
import { OrdersService } from '@/orders/orders.service';
import { EstimatesService } from '@/estimates/estimates.service';
import { buildMaterialEarningsReport } from './referral-report';

jest.mock('@/estimates/reporting/estimate-piece-diagram-metadata', () => ({
  attachEstimatePieceDiagramMetadata: jest.fn(async (_prisma, pieces) => pieces),
}));

function fixture() {
  return {
    id: 10, idUser: 7, number: '1001', units: 2, dealerModeSnapshot: null,
    status: { name: 'Ordered' }, user: { id: 7, role: { name: 'client' } },
    priceT: '1500', customerPriceT: '1500', rateT: '1000', taxRate: '0.07',
    totalPayable: '1605', customerTotalPayable: '1605', customerTaxRate: '0.07',
    materialProcessingCost: '0', materialProcessingCostPending: false,
    pieces: [{ rate: '500', qty: 2 }], installationJob: null, materialRevisions: [],
    payments: [{ id: 1, type: 'MATERIAL', sequence: 1, status: 'PAID', baseAmount: '1605' }],
    order: { id: 1, idEst: 10, userId: 7, status: { name: 'Pending' }, saleSubtotal: '1500', rate: '1000', rateReal: '900',
      netProfit: '500', netProfitReal: '600', referralReward: { terms: { version: 1, mode: 'CUSTOM_PERCENT', percent: '20' }, earnedAmount: '999' } },
  } as any;
}

describe('Company financial reporting of referral costs', () => {
  it('subtracts current reward liability from company profits and preserves gross values', () => {
    const estimate = fixture(); const original = JSON.stringify(estimate);
    const report = buildMaterialEarningsReport(estimate);
    expect(report).toMatchObject({ dealerEarnings: null, referralCosts: { amount: '100.00', status: 'CALCULATED' }, materialProfits: {
      expectedProfit: '500.00', realProfit: '600.00', authenticExpectedProfit: '400.00', authenticRealProfit: '500.00',
    } });
    expect(JSON.stringify(estimate)).toBe(original);
    expect(estimate.order.netProfit).toBe('500');
  });

  it('recognizes the reward cost while material payment is incomplete', () => {
    const estimate = fixture(); estimate.payments[0].baseAmount = '800';
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '100.00', status: 'CALCULATED' },
      materialProfits: { authenticExpectedProfit: '400.00' } });
  });

  it('subtracts existing dealer earnings and referral liability exactly once', () => {
    const estimate = fixture();
    estimate.dealerModeSnapshot = 'INTERNAL';
    estimate.dealerEarningsPlanSnapshot = { version: 2, planId: 1, revision: 1, name: 'Dealer share', basis: 'EXPECTED_PROFIT', percent: '25' };
    estimate.materialProcessingCost = '20';
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ dealerEarnings: { amount: '125.00' },
      referralCosts: { amount: '100.00' }, materialProfits: { expectedProfit: '500.00', realProfit: '600.00',
        authenticExpectedProfit: '275.00', authenticRealProfit: '355.00' } });
  });

  it('marks company net profit unknown while real-cost referral liability is unknown', () => {
    const estimate = fixture(); estimate.order.rateReal = null;
    estimate.order.referralReward.terms = { version: 1, mode: 'DEALER_PLAN', dealerMarkup: '0.20', dealerPriceBasis: 'SAVED_UNIT_APP_BASE',
      earningsPlan: { version: 2, planId: 1, revision: 1, name: 'Real profit', basis: 'REAL_PROFIT', percent: '25' } };
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: null, status: 'PENDING_REAL_COST' },
      materialProfits: { expectedProfit: '500.00', authenticExpectedProfit: null, authenticRealProfit: null } });
    estimate.order.rateReal = '900'; estimate.materialProcessingCostPending = true;
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: null, status: 'PENDING_COST' },
      materialProfits: { authenticExpectedProfit: null, authenticRealProfit: null } });
  });

  it('keeps known custom reward expense when only real processor costs are pending', () => {
    const estimate = fixture(); estimate.materialProcessingCostPending = true;
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '100.00', status: 'CALCULATED' },
      materialProfits: { authenticExpectedProfit: '400.00', authenticRealProfit: null, processingCost: null } });
  });

  it('does not report a zero liability for a material revision or ambiguous review', () => {
    const estimate = fixture(); estimate.materialRevisions = [{ id: 1 }];
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: null, status: 'PENDING_REVIEW' },
      materialProfits: { authenticExpectedProfit: null, authenticRealProfit: null } });
  });

  it('uses the reduced referral cost after approved material refund forgiveness', () => {
    const estimate = fixture(); Object.assign(estimate.payments[0], { netPaidBaseAmount: '1498', refundedAmount: '107', refundCreditAmount: '107' });
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '80.00', status: 'CALCULATED' },
      materialProfits: { expectedProfit: '500.00', realProfit: '600.00', materialRefundCredit: '100.00',
        authenticExpectedProfit: '320.00', authenticRealProfit: '420.00' } });
    estimate.materialProcessingCost = '20';
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ materialProfits: {
      authenticExpectedProfit: '320.00', authenticRealProfit: '400.00',
    } });
  });

  it('subtracts refund forgiveness in addition to a material discount already in the order', () => {
    const estimate = fixture();
    estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
    estimate.order.saleSubtotal = '1400';
    Object.assign(estimate.payments[0], { baseAmount: '1498', netPaidBaseAmount: '1391', refundedAmount: '107', refundCreditAmount: '107' });
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '60.00' }, materialProfits: {
      expectedProfit: '400.00', materialRefundCredit: '100.00', authenticExpectedProfit: '240.00', authenticRealProfit: '340.00',
    } });
  });

  it('does not subtract a revision overpayment refund from company revenue twice', () => {
    const estimate = fixture();
    Object.assign(estimate, { priceT: '1400', customerPriceT: '1400', totalPayable: '1498', customerTotalPayable: '1498' });
    estimate.order.saleSubtotal = '1400';
    Object.assign(estimate.payments[0], { netPaidBaseAmount: '1498', refundedAmount: '107', refundCreditAmount: '0' });
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '80.00' }, materialProfits: {
      expectedProfit: '400.00', materialRefundCredit: '0.00', authenticExpectedProfit: '320.00', authenticRealProfit: '420.00',
    } });
  });

  it('removes the liability for canceled and fully refunded orders', () => {
    const estimate = fixture(); estimate.order.status.name = 'Canceled';
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '0.00', status: 'REVERSED' } });
    estimate.order.status.name = 'Pending';
    Object.assign(estimate.payments[0], { status: 'REFUNDED', netPaidBaseAmount: '0', refundedAmount: '1605', refundCreditAmount: '1605' });
    expect(buildMaterialEarningsReport(estimate)).toMatchObject({ referralCosts: { amount: '0.00', status: 'REVERSED' }, materialProfits: {
      materialRefundCredit: '1500.00', authenticExpectedProfit: '-1000.00', authenticRealProfit: '-900.00',
    } });
  });

  it('returns the exact existing report for orders without referral rewards', () => {
    const estimate = fixture(); delete estimate.order.referralReward;
    expect(buildMaterialEarningsReport(estimate)).toEqual(buildDealerEarningsReport(estimate));
    expect(buildMaterialEarningsReport(estimate)).not.toHaveProperty('referralCosts');
    estimate.materialProcessingCost = '20';
    expect(buildMaterialEarningsReport(estimate)).toEqual(buildDealerEarningsReport(estimate));
  });
});

describe('Order and estimate referral financial report paths', () => {
  function services() {
    const estimate = fixture();
    const order = { ...estimate.order, estimate, extraCharges: [], deliveries: [] };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]),
      estimate: { findUnique: jest.fn().mockResolvedValue(estimate), findMany: jest.fn().mockResolvedValue([estimate]) },
      order: { findUnique: jest.fn().mockResolvedValue(order), findMany: jest.fn().mockResolvedValue([order]) },
    };
    const orders = new OrdersService(prisma as any, {} as any, {} as any, {} as any);
    const estimates = new EstimatesService(prisma as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, { buildSummary: jest.fn().mockReturnValue(null) } as any, {} as any, {} as any);
    jest.spyOn(estimates as any, 'resolveBrandingForEstimate').mockResolvedValue(null);
    jest.spyOn(estimates as any, 'resolveCompanyBranding').mockResolvedValue(null);
    return { prisma, orders, estimates };
  }

  const expectCost = (result: any) => {
    expect(result.referralCosts).toEqual({ amount: '100.00', status: 'CALCULATED' });
    expect(result.materialProfits.authenticExpectedProfit).toBe('400.00');
  };

  it('reports liability in the order list and fetches the frozen terms and unit bases', async () => {
    const { orders, prisma } = services();
    expectCost((await orders.findAll())[0]);
    expect(prisma.order.findMany.mock.calls[0][0].include).toMatchObject({ referralReward: { select: { terms: true } },
      estimate: { include: { pieces: { select: { rate: true, qty: true } }, payments: true } } });
  });

  it('reports liability in the direct order detail path', async () => {
    const { orders } = services(); expectCost(await orders.findOne(1));
  });

  it('reports liability in the authenticated order detail path', async () => {
    const { orders } = services(); expectCost(await orders.findOneForUser(1, { id: 1, role: { name: 'admin' } } as any));
  });

  it('reports liability in the estimate list and fetches material bases', async () => {
    const { estimates, prisma } = services(); expectCost((await estimates.estimates({}))[0]);
    expect(prisma.estimate.findMany.mock.calls[0][0].include).toMatchObject({
      order: { include: { referralReward: { select: { terms: true } } } }, pieces: { select: { rate: true, qty: true } }, payments: true,
    });
  });

  it('reports liability in the estimate detail path', async () => {
    const { estimates } = services(); expectCost(await estimates.estimate({ id: 10 }));
  });

  it('reports liability in the estimate transaction refresh path', async () => {
    const { estimates, prisma } = services();
    expectCost(await (estimates as any).getEstimateWithRelationsInTransaction(prisma, 10));
  });
});

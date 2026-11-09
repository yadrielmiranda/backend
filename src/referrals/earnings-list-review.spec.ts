import { BadRequestException } from '@nestjs/common';
import { buildDealerEarningsReport, SavedDealerEarningsPlanError } from '@/common/dealer-earnings';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { OrdersService } from '@/orders/orders.service';
import { buildMaterialEarningsReport, buildMaterialEarningsReportForRead } from './referral-report';

function estimate(): any {
  return {
    id: 10, idUser: 7, number: '1001', dealerModeSnapshot: 'INTERNAL',
    dealerEarningsPlanSnapshot: null,
    rateT: '1000.00', priceT: '1200.00', customerPriceT: '1500.00', netProfitD: '300.00',
    totalPayable: '1284.00', customerTotalPayable: '1605.00',
    taxRate: '.07', taxAmount: '84.00', customerTaxRate: '.07', customerTaxAmount: '105.00',
    status: { name: 'Active' }, installationJob: null, pieces: [], payments: [], customerCharges: [],
    user: { id: 7, role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
  };
}

describe('List projections with an incomplete saved earnings plan', () => {
  it.each([
    null,
    [],
    { version: 1 },
    { version: 2, planId: 1, revision: 1, name: 'Invalid', basis: 'UNKNOWN', percent: '25' },
    { version: 2, planId: 1, revision: 1, name: 'Invalid', basis: 'EXPECTED_PROFIT', percent: '101' },
    { version: 2, planId: 0, revision: 1, name: 'Invalid', basis: 'EXPECTED_PROFIT', percent: '25' },
  ])('marks the list row for review without changing amounts or weakening strict calculations: %j', savedPlan => {
    const source = { ...estimate(), dealerEarningsPlanSnapshot: savedPlan };
    const before = JSON.stringify(source);
    const report = buildMaterialEarningsReportForRead(source);
    expect(report).toEqual({
      dealerEarnings: null, subdealerEarnings: null, materialProfits: null,
      earningsReview: {
        status: 'PENDING_REVIEW', code: 'INVALID_SAVED_EARNINGS_PLAN',
        message: 'Earnings pending review. The saved earnings plan is missing or invalid.',
      },
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(() => buildMaterialEarningsReport(source)).toThrow(SavedDealerEarningsPlanError);
    expect(() => buildDealerEarningsReport(source)).toThrow(BadRequestException);
  });

  it('returns valid reports unchanged and does not treat a client estimate as incomplete', () => {
    const valid = { ...estimate(), dealerEarningsPlanSnapshot: {
      version: 2, planId: 4, revision: 2, name: 'Saved terms', basis: 'EXPECTED_PROFIT', percent: '20',
    } };
    expect(buildMaterialEarningsReportForRead(valid)).toEqual(buildMaterialEarningsReport(valid));
    expect(buildMaterialEarningsReportForRead(valid).dealerEarnings?.amount).toBe('100.00');
    const client = { ...estimate(), dealerModeSnapshot: null };
    expect(buildMaterialEarningsReportForRead(client)).toEqual(buildMaterialEarningsReport(client));
    expect(buildMaterialEarningsReportForRead(client)).not.toHaveProperty('earningsReview');
  });

  it('does not swallow unrelated errors or invent referral liability', () => {
    const source = estimate();
    source.materialProcessingCost = 'invalid-money';
    expect(() => buildMaterialEarningsReportForRead(source)).toThrow();
    const withReferral = estimate();
    withReferral.order = { referralReward: { terms: {} }, saleSubtotal: '1500', rate: '1000' };
    expect(buildMaterialEarningsReportForRead(withReferral)).toMatchObject({ referralCosts: { amount: null, status: 'PENDING_REVIEW' } });
  });

  it('exposes the review explanation only to administrators, including nested responses', () => {
    const source = { ...estimate(), ...buildMaterialEarningsReportForRead(estimate()) };
    const payload = { rows: [source], estimate: source };
    const admin = presentApiResponse(payload, { id: 1, role: { name: 'admin' } });
    expect(admin.rows[0].earningsReview.status).toBe('PENDING_REVIEW');
    for (const role of ['dealer', 'client', 'operator', 'technician'] as const) {
      const response = presentApiResponse(payload, { id: 7, role: { name: role } });
      expect(response.rows[0]).not.toHaveProperty('earningsReview');
      expect(response.estimate).not.toHaveProperty('earningsReview');
      if (role !== 'operator') expect(response.estimate).not.toHaveProperty('materialProfits');
    }
  });

  it('keeps incomplete and valid orders in the list while order details stay strict', async () => {
    const brokenEstimate = estimate();
    const order = {
      id: 2, idEst: brokenEstimate.id, userId: 7, number: 'ORDER-2', status: { name: 'Pending' },
      dealerModeSnapshot: 'INTERNAL', saleSubtotal: '1500.00', rate: '1000.00', rateReal: '900.00',
      estimate: brokenEstimate, extraCharges: [], deliveries: [],
    };
    const good = { ...order, id: 3, estimate: { ...brokenEstimate, dealerEarningsPlanSnapshot: {
      version: 2, planId: 1, revision: 1, name: 'Valid', basis: 'EXPECTED_PROFIT', percent: '20',
    } } };
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      order: { findMany: jest.fn().mockResolvedValue([order, good]), findUnique: jest.fn().mockResolvedValue(order) },
    };
    const before = JSON.stringify([order, good]);
    const service = new OrdersService(db as any, {} as any, {} as any, {} as any);
    const result = await service.findAll();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 2, earningsReview: { status: 'PENDING_REVIEW' }, dealerEarnings: null, materialProfits: null });
    expect(result[1]).not.toHaveProperty('earningsReview');
    expect(result[1].dealerEarnings?.amount).toBe('100.00');
    expect(JSON.stringify([order, good])).toBe(before);
    await expect(service.findOne(2)).rejects.toThrow(SavedDealerEarningsPlanError);
  });
});

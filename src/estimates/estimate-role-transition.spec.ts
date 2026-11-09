import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { EstimatesService } from './estimates.service';
import { EstimatePieceCalculatorService } from './calculation/estimate-piece-calculator.service';

const admin: any = { id: 1, role: { name: 'admin' } };
const dealer: any = { id: 7, role: { name: 'dealer' } };
const savedPlan = {
  version: 2, planId: 15, revision: 1, name: 'Original plan', basis: 'EXPECTED_PROFIT', percent: '25',
};

function fixture() {
  let estimate: any = {
    id: 1, number: '190001', idUser: 7, status: { id: 1, name: 'Active' },
    order: null, payments: [], materialRevisions: [], installationJob: null,
    pieces: [{ id: 2, qty: 1, mark: 'W1', dealerMarkup: '0' }],
    dealerModeSnapshot: null, dealerEarningsPlanSnapshot: null, dealerNetworkSnapshot: null,
    paymentPlanSnapshot: { version: 1, name: 'Previous terms', definition: {} },
    ownerMarkupSnapshot: '.755125', customerTaxRate: '.07', units: 1,
    rateT: '100', priceT: '175.51', netProfit: '75.51', customerPriceT: '175.51', netProfitD: '0',
    totalPayable: '187.80', customerTotalPayable: '187.80',
    user: { id: 7, username: 'converted-client', parentDealerId: null, isTaxExempt: false,
      markupOverride: null, dealerMode: 'INTERNAL', dealerEarningsPlanId: 15,
      role: { name: 'dealer', markup: new Prisma.Decimal('.15') } },
  };
  const activePlan = { id: 15, revision: 2, name: 'Current plan', basis: 'EXPECTED_PROFIT',
    percent: new Prisma.Decimal('30'), isActive: true };
  const tx: any = {
    $queryRaw: jest.fn(async strings => strings.join(' ').includes('FROM DealerEarningsPlan') ? [activePlan] : [{ id: 1 }]),
    estimate: {
      findUnique: jest.fn(async () => ({ ...estimate })),
      findMany: jest.fn(async () => [{ ...estimate }]),
      updateMany: jest.fn(),
      update: jest.fn(async ({ data }) => {
        Object.assign(estimate, data);
        if (data.dealerEarningsPlanSnapshot === Prisma.DbNull) estimate.dealerEarningsPlanSnapshot = null;
        if (data.status?.connect) estimate.status = { id: 1, name: 'Active' };
        return { ...estimate };
      }),
    },
    user: {
      findUnique: jest.fn(async () => estimate.user),
      findUniqueOrThrow: jest.fn(async () => estimate.user),
      findMany: jest.fn(async () => []),
    },
    estimateStatus: { findUnique: jest.fn(async () => ({ id: 1, name: 'Active' })) },
    globalParameter: { findUnique: jest.fn(async ({ where }) => ({ value: where.key === 'SALES_TAX' ? '.07' : '30' })) },
    piece: { update: jest.fn() },
    pieceMuntin: { deleteMany: jest.fn() },
    estimateAgreement: { findMany: jest.fn(async () => []) },
  };
  tx.$transaction = jest.fn(async work => {
    const before = { ...estimate };
    try { return await work(tx); }
    catch (error) { estimate = before; throw error; }
  });
  const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
  const calculate = jest.spyOn(calculator, 'calculatePieceMetrics').mockImplementation(async (input, markup) => {
    const rate = new Decimal(100), price = rate.mul(markup.plus(1));
    return { ...input, rate, price, customerPrice: price, subtotal: price, customerSubtotal: price,
      markup, dealerMarkupDecimal: new Decimal(0), netProfit: price.minus(rate), netProfitD: new Decimal(0),
      dpPosPsf: new Decimal(0), dpNegPsf: new Decimal(0) } as any;
  });
  const logs = { log: jest.fn() };
  const workflow = { assertEstimateEditAllowed: jest.fn(), refreshUnpaidDealerMeasurements: jest.fn(), refreshAfterEstimateChange: jest.fn() };
  const service = new EstimatesService(tx, logs as any, {} as any, {} as any, calculator,
    {} as any, workflow as any, {} as any, { eligible: jest.fn(async () => []) } as any, {} as any);
  return { service, tx, estimate: () => estimate, activePlan, calculate, logs };
}

describe('Saved estimates when their owner changes role or dealer mode', () => {
  it('lets dealer and administrator list an old client estimate without changing its terms or amounts', async () => {
    const f = fixture(), original = JSON.stringify(f.estimate());
    for (const actor of [dealer, admin]) {
      const rows = await f.service.findAllForUser(actor);
      expect(rows[0]).toMatchObject({ dealerModeSnapshot: null, dealerEarningsPlanSnapshot: null, priceT: '175.51' });
      expect(rows[0].dealerEarnings).toBeNull();
    }
    expect(JSON.stringify(f.estimate())).toBe(original);
    expect(f.tx.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });

  it('does not synchronize or write terms when the dealer opens one estimate', async () => {
    const f = fixture(), original = JSON.stringify(f.estimate());
    jest.spyOn(f.service, 'estimate').mockResolvedValue(f.estimate());
    await f.service.findOneForUser(1, dealer);
    expect(JSON.stringify(f.estimate())).toBe(original);
    expect(f.tx.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });

  it('keeps the complete administrator list available when an old conversion left one earnings plan missing', async () => {
    const f = fixture();
    const broken = { ...f.estimate(), dealerModeSnapshot: 'INTERNAL' };
    f.tx.estimate.findMany.mockResolvedValue([broken, { ...f.estimate(), id: 2, number: '190002' }]);
    const original = JSON.stringify(broken);
    const rows = await f.service.findAllForUser(admin);
    expect(rows.map(row => row.id)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ priceT: '175.51', dealerEarnings: null, materialProfits: null,
      earningsReview: { status: 'PENDING_REVIEW', code: 'INVALID_SAVED_EARNINGS_PLAN' } });
    expect(rows[1]).not.toHaveProperty('earningsReview');
    expect(JSON.stringify(broken)).toBe(original);
    expect(f.tx.estimate.updateMany).not.toHaveBeenCalled();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });

  it('captures internal mode, assigned earnings, owner markup and payment terms together only on recalculate', async () => {
    const f = fixture();
    await f.service.recalculateEstimate(1, admin);
    expect(f.estimate()).toMatchObject({ dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: {
      version: 2, planId: 15, revision: 2, name: 'Current plan', percent: '30',
    } });
    expect(f.estimate().ownerMarkupSnapshot.toString()).toBe('0.15');
    expect(f.estimate().priceT.toString()).toBe('115');
    expect(f.estimate().paymentPlanSnapshot.name).toBe('Material upfront / installation before work');
    expect(f.tx.estimate.update).toHaveBeenCalledTimes(1);
    expect(f.tx.estimate.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: expect.objectContaining({ planId: 15 }),
      paymentPlanSnapshot: expect.objectContaining({ version: 1 }), ownerMarkupSnapshot: expect.any(Prisma.Decimal),
    }) }));
  });

  it('does not replace a valid saved internal arrangement when its catalog or assigned plan changes', async () => {
    const f = fixture();
    Object.assign(f.estimate(), { dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: savedPlan });
    f.estimate().user.dealerEarningsPlanId = 99;
    await f.service.recalculateEstimate(1, admin);
    expect(f.estimate().dealerEarningsPlanSnapshot).toEqual(savedPlan);
    expect(f.estimate().paymentPlanSnapshot.name).toBe('Previous terms');
    expect(f.tx.$queryRaw.mock.calls.some(([strings]: any) => strings.join(' ').includes('FROM DealerEarningsPlan'))).toBe(false);
  });

  it('can capture a missing internal earnings plan during an explicit recalculate', async () => {
    const f = fixture();
    f.estimate().dealerModeSnapshot = 'INTERNAL';
    await f.service.recalculateEstimate(1, admin);
    expect(f.estimate().dealerEarningsPlanSnapshot).toMatchObject({ planId: 15, revision: 2 });
  });

  it('uses the new role payment terms when reactivating instead of restoring the previous role plan', async () => {
    const f = fixture();
    f.estimate().status.name = 'Canceled';
    f.estimate().paymentPlanSnapshot.locked = { at: 'old' };
    await f.service.reactivateEstimate(1, admin);
    expect(f.estimate().dealerModeSnapshot).toBe('INTERNAL');
    expect(f.estimate().dealerEarningsPlanSnapshot).toMatchObject({ planId: 15, revision: 2 });
    expect(f.estimate().paymentPlanSnapshot.name).toBe('Material upfront / installation before work');
    expect(f.estimate().paymentPlanSnapshot).not.toHaveProperty('locked');
  });

  it.each(['EXTERNAL', 'client'])('moves an old internal estimate to %s only during recalculate', async roleOrMode => {
    const f = fixture();
    Object.assign(f.estimate(), { dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: savedPlan });
    if (roleOrMode === 'client') f.estimate().user.role.name = 'client';
    else f.estimate().user.dealerMode = roleOrMode;
    await f.service.recalculateEstimate(1, admin);
    expect(f.estimate().dealerModeSnapshot).toBe(roleOrMode === 'client' ? null : 'EXTERNAL');
    expect(f.estimate().dealerEarningsPlanSnapshot).toBeNull();
  });

  it('retains client mode when its stored user dealerMode is the default EXTERNAL', async () => {
    const f = fixture();
    Object.assign(f.estimate().user, { role: { name: 'client', markup: '.755125' }, dealerMode: 'EXTERNAL' });
    await f.service.recalculateEstimate(1, admin);
    expect(f.estimate().dealerModeSnapshot).toBeNull();
    expect(f.estimate().dealerEarningsPlanSnapshot).toBeNull();
  });

  it.each([null, 0])('rolls back conversion and prices when no usable earnings plan is assigned (%s)', async id => {
    const f = fixture();
    f.estimate().user.dealerEarningsPlanId = id;
    const before = JSON.stringify(f.estimate());
    await expect(f.service.recalculateEstimate(1, admin)).rejects.toThrow('Assign an earnings plan');
    expect(JSON.stringify(f.estimate())).toBe(before);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed saved arrangement before writing any recalculated prices', async () => {
    const f = fixture();
    Object.assign(f.estimate(), { dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: { version: 2 } });
    const original = JSON.stringify(f.estimate());
    await expect(f.service.recalculateEstimate(1, admin)).rejects.toThrow();
    expect(JSON.stringify(f.estimate())).toBe(original);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it('leaves the original estimate untouched when the newly assigned plan is unavailable', async () => {
    const f = fixture(), original = JSON.stringify(f.estimate());
    f.activePlan.isActive = false;
    await expect(f.service.recalculateEstimate(1, admin)).rejects.toThrow('unavailable');
    expect(JSON.stringify(f.estimate())).toBe(original);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });

  it.each([
    { order: { id: 8 } },
    { payments: [{ type: 'MATERIAL', status: 'PAID', stripeSessionId: null }] },
    { payments: [{ type: 'MATERIAL', status: 'PENDING', stripeSessionId: 'cs_1' }] },
    { status: { name: 'Ordered' } },
  ])('keeps existing recalculate restrictions for %j', async patch => {
    const f = fixture();
    Object.assign(f.estimate(), patch);
    const original = JSON.stringify(f.estimate());
    await expect(f.service.recalculateEstimate(1, admin)).rejects.toThrow();
    expect(JSON.stringify(f.estimate())).toBe(original);
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    expect(f.tx.piece.update).not.toHaveBeenCalled();
  });
});

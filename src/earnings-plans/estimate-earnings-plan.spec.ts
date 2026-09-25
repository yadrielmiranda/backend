import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { earningsPlanSnapshot } from './earnings-plan';
import { refreshDraftEarningsPlan } from './estimate-earnings-plan';
import { EstimatesService } from '@/estimates/estimates.service';
import { PaymentsService } from '@/payments/payments.service';

function fixture() {
  const previous = { id: 1, name: 'Gladys', revision: 1, basis: 'REAL_PROFIT' as const, percent: new Prisma.Decimal(50), isActive: true };
  const assigned = { id: 2, name: 'Expected profit', revision: 1, basis: 'EXPECTED_PROFIT' as const, percent: new Prisma.Decimal(25), isActive: true };
  const owner = { id: 7, dealerMode: 'INTERNAL', dealerEarningsPlanId: 2, role: { name: 'dealer' } };
  const stored: any = {
    id: 53, idUser: 7, number: '190962', name: 'Draft', status: { name: 'Active' },
    dealerModeSnapshot: 'INTERNAL', dealerEarningsPlanSnapshot: earningsPlanSnapshot(previous),
    user: owner, order: null, payments: [], pieces: [], installationJob: null, customerCharges: [],
    rateT: '1000', priceT: '1200', customerPriceT: '2000', netProfitD: '800',
    taxAmount: '0', customerTaxAmount: '0', totalPayable: '1200', customerTotalPayable: '2000',
  };
  const copy = () => ({ ...stored, dealerEarningsPlanSnapshot: { ...stored.dealerEarningsPlanSnapshot }, payments: [...stored.payments] });
  const db: any = {
    $queryRaw: jest.fn(async (strings) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM User')) return [{ ...owner }];
      if (sql.includes('FROM DealerEarningsPlan')) return [{ ...assigned }];
      return [{ id: stored.id, dealerEarningsPlanSnapshot: { ...stored.dealerEarningsPlanSnapshot } }];
    }),
    estimate: {
      findUnique: jest.fn(async () => copy()),
      update: jest.fn(async ({ data }) => Object.assign(stored, data)),
    },
  };
  db.$transaction = jest.fn(async work => work(db));
  const service = new EstimatesService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { buildSummary: jest.fn(() => null) } as any, {} as any);
  jest.spyOn(service as any, 'resolveBrandingForEstimate').mockResolvedValue(null);
  jest.spyOn(service as any, 'resolveCompanyBranding').mockResolvedValue(null);
  return { db, service, stored, assigned, owner, copy };
}

describe('Internal dealer earnings before the first checkout, payment or order', () => {
  it('refreshes an existing unpaid estimate from 50% real profit to its newly assigned 25% expected profit when opened', async () => {
    const f = fixture();
    const report = await f.service.estimate({ id: 53 });
    expect(report?.dealerEarnings).toMatchObject({ planId: 2, percent: '25', basis: 'EXPECTED_PROFIT', amount: '250.00' });
    expect(f.stored.dealerEarningsPlanSnapshot).toEqual(earningsPlanSnapshot(f.assigned));
    expect([f.stored.rateT, f.stored.priceT, f.stored.customerPriceT, f.stored.netProfitD]).toEqual(['1000', '1200', '2000', '800']);
  });

  it('refreshes revisions of the same assigned plan and does not rewrite an unchanged snapshot on every read', async () => {
    const f = fixture();
    f.stored.dealerEarningsPlanSnapshot = earningsPlanSnapshot(f.assigned);
    await f.service.estimate({ id: 53 });
    expect(f.db.estimate.update).not.toHaveBeenCalled();
    f.assigned.percent = new Prisma.Decimal(30);
    f.assigned.revision++;
    expect((await f.service.estimate({ id: 53 }))?.dealerEarnings).toMatchObject({ percent: '30', amount: '300.00' });
    await f.service.estimate({ id: 53 });
    expect(f.db.estimate.update).toHaveBeenCalledTimes(1);
  });

  it.each(['PENDING', 'PAID', 'REFUNDED', 'FAILED', 'CANCELED', 'EXPIRED'])('keeps the saved conditions after a %s payment, even when its checkout ID was cleared', async status => {
    const f = fixture();
    f.stored.payments = [{ id: 8, status, stripeSessionId: null }];
    const saved = JSON.stringify(f.stored.dealerEarningsPlanSnapshot);
    const report = await f.service.estimate({ id: 53 });
    expect(report?.dealerEarnings).toMatchObject({ planId: 1, percent: '50', basis: 'REAL_PROFIT' });
    expect(JSON.stringify(f.stored.dealerEarningsPlanSnapshot)).toBe(saved);
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it.each(['Expired', 'Ordered', 'Pending order review'])('preserves the snapshot in status %s', async name => {
    const f = fixture();
    f.stored.status.name = name;
    await refreshDraftEarningsPlan(f.db, f.copy());
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('preserves a linked order even if the estimate status is still Active', async () => {
    const f = fixture();
    f.stored.order = { id: 5 };
    await refreshDraftEarningsPlan(f.db, f.copy());
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('rechecks payment activity after locking, when the caller holds an older copy of the estimate', async () => {
    const f = fixture();
    const earlier = f.copy();
    f.stored.payments = [{ id: 8, status: 'PENDING', stripeSessionId: 'cs_started' }];
    await refreshDraftEarningsPlan(f.db, earlier);
    expect(earlier.dealerEarningsPlanSnapshot.planId).toBe(1);
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('preserves the historical zero snapshot without a catalog plan', async () => {
    const f = fixture();
    f.stored.dealerEarningsPlanSnapshot = {
      version: 2, planId: null, revision: null, name: 'No earnings plan assigned', basis: 'DEALER_MARKUP', percent: '0',
    };
    expect((await f.service.estimate({ id: 53 }))?.dealerEarnings).toMatchObject({ planId: null, percent: '0', amount: '0.00' });
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('keeps a sealed plan even if payment rows are no longer supplied', async () => {
    const f = fixture();
    f.stored.dealerEarningsPlanSnapshot.lockedAt = '2026-09-25T21:00:00.000Z';
    await refreshDraftEarningsPlan(f.db, f.copy());
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('uses a newly committed seal even when a transaction previously read an older snapshot', async () => {
    const f = fixture();
    const earlier = f.copy();
    f.stored.dealerEarningsPlanSnapshot.lockedAt = '2026-09-25T21:00:00.000Z';
    f.db.estimate.findUnique.mockResolvedValueOnce(earlier);
    await refreshDraftEarningsPlan(f.db, { ...earlier });
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('allows a draft with a real 0% catalog plan to follow a later assignment', async () => {
    const f = fixture();
    f.stored.dealerEarningsPlanSnapshot.percent = '0';
    await refreshDraftEarningsPlan(f.db, f.copy());
    expect(f.stored.dealerEarningsPlanSnapshot).toMatchObject({ planId: 2, percent: '25' });
  });

  it.each(['EXTERNAL', null])('does not change a sale recorded with dealer mode %s', async mode => {
    const f = fixture();
    f.stored.dealerModeSnapshot = mode;
    await refreshDraftEarningsPlan(f.db, f.copy());
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.estimate.update).not.toHaveBeenCalled();
  });

  it('refreshes immediately before payment even if nobody has reopened the estimate; previews do not freeze or update it', async () => {
    const f = fixture();
    const workflow = { getPaymentContext: jest.fn(async () => ({
      estimate: f.copy(), type: 'MATERIAL', paymentSequence: 1,
      baseAmount: new Decimal(2000), surchargePercent: new Decimal(0),
      surchargeAmount: new Decimal(0), totalAmount: new Decimal(2000),
    })) };
    const payments = new PaymentsService(f.db, { get: () => 'sk_test_earnings' } as any, workflow as any, {} as any);
    const actor = { id: 7, role: { name: 'dealer' } };
    await (payments as any).selectedPaymentContexts(f.db, { estimateId: 53, type: 'MATERIAL' }, actor, true);
    expect(f.db.estimate.update).not.toHaveBeenCalled();
    await (payments as any).selectedPaymentContexts(f.db, { estimateId: 53, type: 'MATERIAL' }, actor);
    expect(f.stored.dealerEarningsPlanSnapshot).toMatchObject({ percent: '25', basis: 'EXPECTED_PROFIT' });
    expect(f.stored.dealerEarningsPlanSnapshot.lockedAt).toEqual(expect.any(String));
    f.stored.payments.push({ id: 8, status: 'PENDING' });
    f.assigned.percent = new Prisma.Decimal(30);
    f.assigned.revision++;
    await (payments as any).selectedPaymentContexts(f.db, { estimateId: 53, type: 'MATERIAL' }, actor);
    expect(f.stored.dealerEarningsPlanSnapshot.percent).toBe('25');
  });
});

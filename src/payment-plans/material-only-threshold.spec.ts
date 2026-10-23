import { Prisma } from '@prisma/client';
import { PlanDefinition, PlanSnapshot, planRows } from './payment-plan';
import { buildPaymentSchedule, getPaymentSchedule, installmentContext, resolveNewPlan,
  synchronizeScheduleChanges, withCurrentPaymentPlan } from './payment-schedule';

const definition: PlanDefinition = {
  withoutInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
    { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
  ],
  withInstallation: [
    { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
    { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
    { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
  ],
};
function snapshot(threshold: string | null = null): PlanSnapshot {
  return { version: 1, planId: 3, name: 'Saved split payment plan',
    definition: JSON.parse(JSON.stringify(definition)),
    ...(threshold === null ? {} : { materialOnlyUpfront: { version: 1 as const, threshold } }) };
}
function estimate(material = '240.00', threshold: string | null = null): any {
  return { id: 17, idUser: 8, number: '190917', units: 1,
    createdAt: new Date('2026-01-02T12:00:00Z'), dealerModeSnapshot: 'EXTERNAL',
    priceT: material, totalPayable: material, customerTotalPayable: material,
    taxAmount: '0.00', taxRate: 0, paymentPlanSnapshot: snapshot(threshold),
    payments: [], status: { name: 'Active' }, order: null, installationJob: null };
}
function dbFor(est: any, threshold: string | null = '275.50'): any {
  return {
    estimate: {
      findUnique: jest.fn(async () => est),
      findUniqueOrThrow: jest.fn(async () => est),
      update: jest.fn(async ({ data }) => Object.assign(est, data)),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ paymentPlanId: 3, role: { paymentPlanId: 2 } })) },
    paymentPlan: { findUnique: jest.fn(async () => ({ id: 3, name: 'Assigned plan', definition })) },
    globalParameter: { findUnique: jest.fn(async () => threshold === null ? null : ({ value: new Prisma.Decimal(threshold) })) },
  };
}
function payment(baseAmount: string): any {
  return { id: 89, type: 'INSTALLMENT', status: 'PAID', sequence: 1,
    baseAmount, amount: baseAmount, surchargeAmount: '0.00', stripeSessionId: 'cs_existing' };
}
function savedLock(est: any) {
  const amounts = { material: est.totalPayable, installation: '0.00', permit: '0.00', city: '0.00' };
  est.paymentPlanSnapshot.locked = {
    amounts, rows: planRows(est.paymentPlanSnapshot, amounts, false), at: '2026-01-03T12:00:00Z',
  };
}
async function amounts(db: any, id = 17) {
  return (await getPaymentSchedule(db, id))?.rows.map(row => row.amount);
}

describe('Current material-only threshold for estimates without actual payments', () => {
  it.each([
    ['275.49', ['275.49']], ['275.50', ['275.50']], ['275.51', ['137.76', '137.75']],
  ])('compares the final material total %s inclusively', async (total, expected) => {
    const est = estimate(total as string), db = dbFor(est), original = JSON.stringify(est);
    const schedule = (await getPaymentSchedule(db, est.id))!;
    expect(schedule.rows.map(row => row.amount)).toEqual(expected);
    expect(schedule).not.toHaveProperty('materialOnlyUpfront');
    expect(schedule.rows[0].milestone).toBe('ORDER');
    expect(schedule.total).toBe(total);
    expect(schedule.next?.balance).toBe((expected as string[])[0]);
    expect(db.globalParameter.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'MATERIAL_ONLY_UPFRONT_THRESHOLD' },
    }));
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(est)).toBe(original);
  });

  it.each(['0.00', null])('keeps the assigned split when the current rule is disabled (%s)', async threshold => {
    expect(await amounts(dbFor(estimate('240.00', '1400.00'), threshold))).toEqual(['120.00', '120.00']);
  });

  it('uses the administrator amount rather than a hardcoded sample', async () => {
    const est = estimate('1400.00'), db = dbFor(est, '1400.00');
    expect(await amounts(db)).toEqual(['1400.00']);
    est.totalPayable = '1400.01';
    expect(await amounts(db)).toEqual(['700.01', '700.00']);
  });

  it.each(['2025-01-01T12:00:00Z', '2026-10-24T12:00:00Z'])('applies to unpaid estimates created on %s', async date => {
    const est = estimate();
    est.createdAt = new Date(date);
    expect(await amounts(dbFor(est))).toEqual(['240.00']);
  });

  it.each([null, '0.00', '100.00', '1400.00'])('uses current configuration instead of a previously saved %s', async previous => {
    const est = estimate('240.00', previous);
    expect(await amounts(dbFor(est))).toEqual(['240.00']);
    expect(est.paymentPlanSnapshot.materialOnlyUpfront?.threshold ?? null).toBe(previous);
  });

  it('rechecks the same unpaid estimate when the global limit changes in either direction', async () => {
    const est = estimate('300.00', '0.00'), db = dbFor(est), original = JSON.stringify(est);
    expect(await amounts(db)).toEqual(['150.00', '150.00']);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('1400.00') });
    expect(await amounts(db)).toEqual(['300.00']);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('0.00') });
    expect(await amounts(db)).toEqual(['150.00', '150.00']);
    expect(JSON.stringify(est)).toBe(original);
  });

  it('rechecks total edits in both directions without replacing the assigned plan', async () => {
    const est = estimate(), db = dbFor(est), original = JSON.stringify(est.paymentPlanSnapshot);
    expect(await amounts(db)).toEqual(['240.00']);
    est.totalPayable = '300.00';
    expect(await amounts(db)).toEqual(['150.00', '150.00']);
    est.totalPayable = '250.00';
    expect(await amounts(db)).toEqual(['250.00']);
    expect(JSON.stringify(est.paymentPlanSnapshot)).toBe(original);
  });

  it('compares the taxed total rather than its pretax subtotal', async () => {
    const est = estimate('280.00');
    est.priceT = '260.00'; est.taxAmount = '20.00';
    expect(await amounts(dbFor(est))).toEqual(['140.00', '140.00']);
  });

  it('uses the discounted and taxed material total when a discount crosses the limit', async () => {
    const est = estimate('330.00');
    est.priceT = '300.00'; est.taxAmount = '30.00'; est.taxRate = '0.10';
    est.manualDiscount = { scope: 'MATERIAL', type: 'PERCENTAGE', value: '20', materialDiscountBasis: 'BEFORE_TAX' };
    expect(await amounts(dbFor(est))).toEqual(['264.00']);
    expect(est.totalPayable).toBe('330.00');
  });

  it('keeps installation terms unchanged and rechecks when unpaid installation is canceled', async () => {
    const est = estimate(), db = dbFor(est);
    est.installationJob = { status: 'MATERIAL_PAYMENT_PENDING', quotes: [{ status: 'APPROVED', total: '0.00' }], permit: null, appointments: [] };
    expect(await amounts(db)).toEqual(['120.00', '96.00', '24.00']);
    est.installationJob.status = 'CANCELED';
    expect(await amounts(db)).toEqual(['240.00']);
  });

  it('resolves the assigned plan without freezing the global limit at creation', async () => {
    const db = dbFor(estimate()), result = await resolveNewPlan(db, 8);
    expect(result.materialOnlyUpfront).toBeUndefined();
    expect(result.definition).toEqual(definition);
    expect(result.definition).not.toBe(definition);
    expect(db.globalParameter.findUnique).not.toHaveBeenCalled();
  });

  it('keeps legacy estimates without snapshots on their original material payment path', async () => {
    const est = estimate(); est.paymentPlanSnapshot = null;
    const db = dbFor(est), original = JSON.stringify(est);
    expect((await withCurrentPaymentPlan(db, est)).paymentPlanSnapshot).toBeNull();
    expect(await getPaymentSchedule(db, est.id)).toBeNull();
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(est)).toBe(original);
  });

  it('applies the current rule when an existing order has no payment history', async () => {
    const est = estimate(); est.order = { id: 7, status: { name: 'In production' } };
    const original = JSON.stringify(est);
    expect(await amounts(dbFor(est))).toEqual(['240.00']);
    expect(JSON.stringify(est)).toBe(original);
  });
});

describe('Actual payment history protects agreed conditions', () => {
  it.each([
    { kind: 'partial installment', record: payment('10.00') },
    { kind: 'zero paid confirmation', record: payment('0.00') },
    { kind: 'installation deposit', record: { ...payment('10.00'), type: 'INSTALLATION_DEPOSIT' } },
    { kind: 'material payment', record: { ...payment('10.00'), type: 'MATERIAL' } },
    { kind: 'other paid receipt', record: { ...payment('10.00'), type: 'EXTRA' } },
    { kind: 'fully refunded', record: { ...payment('10.00'), status: 'REFUNDED', netPaidBaseAmount: '0.00', refundedAmount: '10.00' } },
    { kind: 'paid date remains', record: { ...payment('10.00'), status: 'CANCELED', paidAt: new Date('2026-01-04T12:00:00Z') } },
    { kind: 'positive net principal', record: { ...payment('10.00'), status: 'PENDING', stripeSessionId: null, netPaidBaseAmount: '5.00' } },
    { kind: 'refund remains', record: { ...payment('10.00'), status: 'CANCELED', refundedAmount: '10.00' } },
    { kind: 'refund credit remains', record: { ...payment('10.00'), status: 'CANCELED', refundCreditAmount: '10.00' } },
    { kind: 'receipt remains', record: { ...payment('10.00'), status: 'CANCELED', receipts: [{ id: 91 }] } },
    { kind: 'refund review remains', record: { ...payment('10.00'), status: 'CANCELED', refundReviewPending: true } },
  ])('preserves the earlier split with $kind history', async ({ record }) => {
    const est = estimate(); est.payments = [record];
    const db = dbFor(est, '1400.00'), original = JSON.stringify(est);
    // An existing approved refund credit still reduces its original installment.
    expect(await amounts(db)).toEqual(record.refundCreditAmount ? ['110.00', '120.00'] : ['120.00', '120.00']);
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(est)).toBe(original);
  });

  it('preserves locked historical installments and receipts', async () => {
    const est = estimate(); savedLock(est);
    est.payments = [payment('120.00')]; est.order = { id: 7, status: { name: 'Awaiting release' } };
    const db = dbFor(est, '1400.00'), original = JSON.stringify(est);
    await synchronizeScheduleChanges(db, est.id);
    expect((await getPaymentSchedule(db, est.id))?.next?.balance).toBe('120.00');
    expect(JSON.stringify(est)).toBe(original);
  });

  it('does not apply an earlier threshold marker to an unlocked estimate with a partial payment', async () => {
    const est = estimate('240.00', '1400.00');
    est.payments = [payment('10.00')];
    const original = JSON.stringify(est);
    expect(await amounts(dbFor(est, '1400.00'))).toEqual(['120.00', '120.00']);
    expect(JSON.stringify(est)).toBe(original);
  });

  it.each(['CANCELED', 'FAILED', 'PENDING'])('ignores a %s attempt without session or actual money', async status => {
    const est = estimate(); savedLock(est);
    est.payments = [{ ...payment('120.00'), status, stripeSessionId: null, netPaidBaseAmount: '0.00' }];
    const original = JSON.stringify(est), prepared = await withCurrentPaymentPlan(dbFor(est), est);
    expect(prepared.paymentPlanSnapshot.locked).toBeUndefined();
    expect(buildPaymentSchedule(prepared)?.rows.map(row => row.amount)).toEqual(['240.00']);
    expect(JSON.stringify(est)).toBe(original);
  });

  it('discards unpaid canceled-checkout terms and adjustments in the projection only', async () => {
    const est = estimate('240.00', '0.00'); savedLock(est);
    est.paymentPlanSnapshot.adjustments = [{ sequence: 101, milestone: 'ORDER', title: 'Unpaid adjustment', description: '', amount: '20.00' }];
    est.payments = [{ ...payment('120.00'), status: 'CANCELED', stripeSessionId: null }];
    const original = JSON.stringify(est), prepared = await withCurrentPaymentPlan(dbFor(est), est);
    expect(prepared.paymentPlanSnapshot.locked).toBeUndefined();
    expect(prepared.paymentPlanSnapshot.adjustments).toBeUndefined();
    expect(buildPaymentSchedule(prepared)?.rows.map(row => row.amount)).toEqual(['240.00']);
    expect(JSON.stringify(est)).toBe(original);
  });
});

describe('Checkout fixes current conditions and approved adjustments preserve them', () => {
  it('previews without saving, then fixes the effective rule at checkout', async () => {
    const est = estimate(), db = dbFor(est);
    expect((await installmentContext(db, est.id, 1, true)).row.amount).toBe('240.00');
    expect(db.estimate.update).not.toHaveBeenCalled();
    await installmentContext(db, est.id, 1);
    expect(est.paymentPlanSnapshot.locked).toMatchObject({
      materialOnlyUpfrontApplied: true,
      effectiveDefinition: { withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }] },
      rows: [{ milestone: 'ORDER', amount: '240.00' }],
    });
    expect(est.paymentPlanSnapshot.definition).toEqual(definition);
  });

  it('keeps an open checkout fixed despite a new global limit and rejects changing its amount', async () => {
    const est = estimate(), db = dbFor(est, '0.00');
    await installmentContext(db, est.id, 1);
    est.payments = [{ ...payment('120.00'), status: 'PENDING' }];
    const original = JSON.stringify(est);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('1400.00') });
    expect(await amounts(db)).toEqual(['120.00', '120.00']);
    expect(JSON.stringify(est)).toBe(original);
    est.totalPayable = '300.00';
    await expect(synchronizeScheduleChanges(db, est.id)).rejects.toThrow('Cancel');
  });

  it('preserves an unresolved payment intent without a session and blocks amount changes', async () => {
    const est = estimate(), db = dbFor(est, '0.00');
    await installmentContext(db, est.id, 1);
    est.payments = [{ ...payment('120.00'), status: 'PENDING', stripeSessionId: null, stripePaymentIntentId: 'pi_unresolved' }];
    const originalLock = JSON.stringify(est.paymentPlanSnapshot.locked), originalPayments = JSON.stringify(est.payments);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('1400.00') });
    db.estimate.update.mockClear();
    expect(await amounts(db)).toEqual(['120.00', '120.00']);
    est.totalPayable = '300.00';
    await expect(synchronizeScheduleChanges(db, est.id)).rejects.toThrow();
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(est.paymentPlanSnapshot.locked)).toBe(originalLock);
    expect(JSON.stringify(est.payments)).toBe(originalPayments);
  });

  it.each([
    ['240.00', '300.00', ['150.00', '150.00']], ['300.00', '240.00', ['240.00']],
  ])('rechecks canceled checkout after an edit from %s to %s', async (before, after, expected) => {
    const est = estimate(before as string), db = dbFor(est), context = await installmentContext(db, est.id, 1);
    est.payments = [{ ...payment(context.row.amount), status: 'CANCELED', stripeSessionId: null }];
    const originalPayments = JSON.stringify(est.payments);
    est.totalPayable = after;
    await synchronizeScheduleChanges(db, est.id);
    expect(await amounts(db)).toEqual(expected);
    expect(JSON.stringify(est.payments)).toBe(originalPayments);
  });

  it.each([
    { quote: 'draft', quotes: [{ status: 'DRAFT', total: '60.00' }], expected: ['150.00', '120.00', '30.00'] },
    { quote: 'absent', quotes: [], expected: ['120.00', '96.00', '24.00'] },
  ])('reopens canceled material checkout for requested installation with a $quote quote', async ({ quotes, expected }) => {
    const est = estimate(), db = dbFor(est), context = await installmentContext(db, est.id, 1);
    est.payments = [{ ...payment(context.row.amount), status: 'CANCELED', stripeSessionId: null }];
    const originalPayments = JSON.stringify(est.payments);
    est.installationJob = { status: 'DRAFT', quotes, permit: null, appointments: [] };
    await synchronizeScheduleChanges(db, est.id);
    const schedule = (await getPaymentSchedule(db, est.id))!;
    expect(schedule.rows.map(row => row.amount)).toEqual(expected);
    expect(schedule.provisional).toBe(true);
    expect(schedule.next).toBeNull();
    expect(schedule.fullBalance).toBeNull();
    expect(JSON.stringify(est.payments)).toBe(originalPayments);
  });

  it.each([
    { quote: 'draft', quotes: [{ status: 'DRAFT', total: '60.00' }] }, { quote: 'absent', quotes: [] },
  ])('blocks installation with a $quote quote while material checkout is open', async ({ quotes }) => {
    const est = estimate(), db = dbFor(est), context = await installmentContext(db, est.id, 1);
    est.payments = [{ ...payment(context.row.amount), status: 'PENDING' }];
    const originalLock = JSON.stringify(est.paymentPlanSnapshot.locked), originalPayments = JSON.stringify(est.payments);
    db.estimate.update.mockClear();
    est.installationJob = { status: 'DRAFT', quotes, permit: null, appointments: [] };
    await expect(synchronizeScheduleChanges(db, est.id)).rejects.toThrow('Cancel');
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(JSON.stringify(est.paymentPlanSnapshot.locked)).toBe(originalLock);
    expect(JSON.stringify(est.payments)).toBe(originalPayments);
  });

  it.each([
    ['240.00', '340.00', [{ milestone: 'ORDER', amount: '100.00' }]],
    ['300.00', '340.00', [{ milestone: 'ORDER', amount: '20.00' }, { milestone: 'RELEASE', amount: '20.00' }]],
    ['300.00', '240.00', [{ milestone: 'ORDER', amount: '-30.00' }, { milestone: 'RELEASE', amount: '-30.00' }]],
  ])('preserves the paid agreement for an adjustment from %s to %s', async (before, after, expected) => {
    const est = estimate(before as string), db = dbFor(est), context = await installmentContext(db, est.id, 1);
    est.payments = [payment(context.row.amount)]; est.order = { id: 7, status: { name: 'Awaiting release' } };
    const originalLock = JSON.stringify(est.paymentPlanSnapshot.locked), originalPayments = JSON.stringify(est.payments);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('1400.00') });
    est.totalPayable = after;
    await synchronizeScheduleChanges(db, est.id, { approvedMaterialRevision: true, materialRevisionId: 15 });
    expect(est.paymentPlanSnapshot.adjustments.map(({ milestone, amount }) => ({ milestone, amount }))).toEqual(expected);
    expect(est.paymentPlanSnapshot.adjustments.every(row => row.materialRevisionId === 15)).toBe(true);
    expect(JSON.stringify(est.paymentPlanSnapshot.locked)).toBe(originalLock);
    expect(JSON.stringify(est.payments)).toBe(originalPayments);
    expect((await getPaymentSchedule(db, est.id))?.total).toBe(after);
    await synchronizeScheduleChanges(db, est.id, { approvedMaterialRevision: true, materialRevisionId: 15 });
    expect(est.paymentPlanSnapshot.adjustments).toHaveLength((expected as unknown[]).length);
  });
});

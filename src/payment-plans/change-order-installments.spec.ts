import * as assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { changeOrderInstallments } from './change-order-installments';
import { buildPaymentSchedule, installmentContext, synchronizeScheduleChanges } from './payment-schedule';
import { PlanDefinition, PlanSnapshot, planRows, ScheduleAmounts } from './payment-plan';
import { changeOrderPaymentPreview } from '@/contracts/change-order-payment-preview';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const amounts = (installation = '200.00', material = '1000.00', city = '0.00'): ScheduleAmounts =>
  ({ material, installation, permit: '0.00', city });
const split: PlanDefinition = {
  withoutInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
    { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
  ],
  withInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
    { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
    { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 50 },
    { milestone: 'COMPLETE', basis: 'INSTALLATION', percent: 50 },
  ],
};
const project: PlanDefinition = { ...split, withInstallation: [
  { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
  { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
  { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
] };
function fixture(definition = split) {
  const snapshot: PlanSnapshot = { version: 1, planId: 7, name: 'Saved plan', definition: copy(definition) };
  snapshot.locked = { amounts: amounts(), rows: planRows(snapshot, amounts(), true), at: '2026-09-26' };
  const estimate: any = {
    id: 35, units: 2, status: { name: 'Ordered' }, dealerModeSnapshot: 'INTERNAL',
    customerTotalPayable: '1000.00', totalPayable: '800.00',
    order: { id: 8, status: { name: 'Pending' } }, materialRevisions: [],
    paymentPlanSnapshot: snapshot,
    installationJob: { status: 'MATERIAL_PAID', appointments: [], permit: null,
      quotes: [{ status: 'APPROVED', total: '400.00' }] },
    payments: [{ id: 1, type: 'INSTALLMENT', sequence: 1, status: 'PAID', baseAmount: snapshot.locked.rows[0].amount }],
  };
  let writes = 0;
  const db: any = { estimate: {
    findUnique: async () => estimate, findUniqueOrThrow: async () => estimate,
    update: async ({ data }: any) => { writes++; Object.assign(estimate, data); return estimate; },
  } };
  const sync = () => synchronizeScheduleChanges(db, 35);
  const rows = () => estimate.paymentPlanSnapshot.adjustments ?? [];
  const pay = (sequence: number, baseAmount: string) => estimate.payments.push({
    id: estimate.payments.length + 1, type: 'INSTALLMENT', sequence, status: 'PAID', baseAmount,
  });
  return { estimate, db, sync, rows, pay, writes: () => writes };
}
const distribution = (rows: any[]) => rows.map(row => [row.milestone, row.amount]);

describe('Installation-only Change Orders use the agreed payment plan', () => {
  it('splits 200 into 100 before installation and 100 after completion, never release', async () => {
    const f = fixture(); const locked = copy(f.estimate.paymentPlanSnapshot.locked); const paid = copy(f.estimate.payments);
    await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '100.00'], ['COMPLETE', '100.00']]);
    assert.ok(f.rows().every(row => !row.materialRevision && row.title.startsWith('Change order')));
    assert.deepEqual(f.estimate.paymentPlanSnapshot.locked, locked); assert.deepEqual(f.estimate.payments, paid);
    assert.equal(buildPaymentSchedule(f.estimate)!.balance, '900.00');
    await f.sync(); assert.equal(f.writes(), 1);
  });
  it('uses 50/40/10 of the installation difference when the basis is PROJECT', async () => {
    const f = fixture(project); await f.sync();
    assert.deepEqual(distribution(f.rows()), [['ORDER', '100.00'], ['RELEASE', '80.00'], ['COMPLETE', '20.00']]);
    assert.equal(buildPaymentSchedule(f.estimate)!.next?.sequence, 101);
  });
  it('supports 100 percent of installation before work', async () => {
    const f = fixture({ ...split, withInstallation: [...split.withoutInstallation,
      { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 100 }] });
    await f.sync(); assert.deepEqual(distribution(f.rows()), [['INSTALL', '200.00']]);
  });
  it('supports 100 percent of the project at order placement', async () => {
    const f = fixture({ ...project, withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 100 }] });
    await f.sync(); assert.deepEqual(distribution(f.rows()), [['ORDER', '200.00']]);
    assert.equal(buildPaymentSchedule(f.estimate)!.next?.balance, '200.00');
  });
  it('does not replace the frozen plan with the current user plan', async () => {
    const f = fixture(); f.estimate.user = { paymentPlanId: 999 }; await f.sync();
    assert.equal(f.estimate.paymentPlanSnapshot.planId, 7);
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '100.00'], ['COMPLETE', '100.00']]);
  });
  it('adds only the difference in a second change, keeping prior adjustments and payments', async () => {
    const f = fixture(); await f.sync(); f.pay(101, '100.00');
    const first = copy(f.rows()); const payments = copy(f.estimate.payments);
    f.estimate.installationJob.quotes[0].total = '650.00'; await f.sync();
    assert.deepEqual(f.rows().slice(0, 2), first); assert.deepEqual(f.estimate.payments, payments);
    assert.deepEqual(distribution(f.rows().slice(2)), [['INSTALL', '125.00'], ['COMPLETE', '125.00']]);
    assert.deepEqual(f.rows().map(row => row.sequence), [101, 102, 103, 104]);
    await f.sync(); assert.equal(f.rows().length, 4);
  });
  it('handles additional installation services as part of the approved installation total', async () => {
    const f = fixture(); f.estimate.installationJob.quotes[0].total = '475.50'; await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '137.75'], ['COMPLETE', '137.75']]);
  });
  it('keeps a simultaneous City Fee separate at 100 percent and does not duplicate it', async () => {
    const f = fixture(); f.estimate.installationJob.permit = { permitFeeSnapshot: '0.00', cityFee: '25.00' };
    await f.sync(); await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '100.00'], ['COMPLETE', '100.00'], ['ORDER', '25.00']]);
    assert.equal(f.rows()[2].kind, 'CITY_FEE'); assert.equal(buildPaymentSchedule(f.estimate)!.total, '1425.00');
  });
  it('does not redistribute a City Fee-only adjustment', async () => {
    const f = fixture(project); f.estimate.installationJob.quotes[0].total = '200.00';
    f.estimate.installationJob.permit = { permitFeeSnapshot: '0.00', cityFee: '100.00' }; await f.sync();
    assert.deepEqual(distribution(f.rows()), [['ORDER', '100.00']]); assert.equal(f.rows()[0].kind, 'CITY_FEE');
  });
  it('does not add charges while the installation quote awaits approval', async () => {
    const f = fixture(); f.estimate.installationJob.quotes[0].status = 'CUSTOMER_APPROVAL_PENDING';
    await f.sync(); assert.equal(f.writes(), 0);
  });
  it('blocks rescheduling amounts while checkout remains open', async () => {
    const f = fixture(); f.estimate.payments.push({ status: 'PENDING', stripeSessionId: 'cs_open' });
    await assert.rejects(f.sync, /Cancel the open checkout/); assert.equal(f.writes(), 0);
  });
  it('leaves estimates without a saved plan on their legacy terms', async () => {
    const f = fixture(); f.estimate.paymentPlanSnapshot = null; await f.sync(); assert.equal(f.writes(), 0);
  });
  it('credits a reduced installation without changing the original receipts', async () => {
    const f = fixture(); f.estimate.installationJob.quotes[0].total = '100.00';
    const payments = copy(f.estimate.payments); await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '-50.00'], ['COMPLETE', '-50.00']]);
    assert.deepEqual(f.estimate.payments, payments); assert.equal(buildPaymentSchedule(f.estimate)!.total, '1100.00');
  });
  it('retains the installation variant when crediting a canceled installation', async () => {
    const f = fixture(); f.estimate.installationJob.status = 'CANCELED'; await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '-100.00'], ['COMPLETE', '-100.00']]);
    assert.equal(buildPaymentSchedule(f.estimate)!.total, '1000.00');
  });
  it('keeps exact cents for odd amounts and configurable percentages', () => {
    for (const percent of [33.33, 50, 65.25]) {
      const p: PlanSnapshot = { version: 1, name: 'Odd cents', planId: null, definition: {
        ...split, withInstallation: [...split.withoutInstallation,
          { milestone: 'INSTALL', basis: 'INSTALLATION', percent },
          { milestone: 'COMPLETE', basis: 'INSTALLATION', percent: 100 - percent }],
      } };
      for (let cents = 1; cents <= 200; cents++) {
        const delta = new Decimal(cents).div(100).toFixed(2);
        const rows = changeOrderInstallments(p, amounts('0.00'), amounts(delta), true, 101, 1);
        assert.equal(rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2), delta);
      }
    }
  });
  it('preserves changed bases even when material decreases as installation increases', async () => {
    const f = fixture(); f.estimate.customerTotalPayable = '800.00'; await f.sync();
    assert.deepEqual(distribution(f.rows()), [['ORDER', '-100.00'], ['RELEASE', '-100.00'], ['INSTALL', '100.00'], ['COMPLETE', '100.00']]);
    assert.equal(buildPaymentSchedule(f.estimate)!.total, '1200.00'); await f.sync(); assert.equal(f.writes(), 1);
  });
});

describe('Installation payment timing and independent selection', () => {
  it('does not demand an installation installment early, but allows voluntary individual advance', async () => {
    const f = fixture(); await f.sync();
    const s = buildPaymentSchedule(f.estimate)!;
    assert.equal(s.rows.find(row => row.sequence === 101)?.status, 'UPCOMING');
    await assert.rejects(() => installmentContext(f.db, 35, 101), /not available/);
    const c = await installmentContext(f.db, 35, 101, true, true);
    assert.equal(c.row.balance, '100.00'); assert.equal(c.row.sequence, 101);
  });
  it('blocks installation until its additional initial installment is paid, not its final one', async () => {
    const f = fixture(); await f.sync(); f.estimate.order.status.name = 'Ready to pick up';
    f.pay(2, '500.00'); f.pay(3, '100.00');
    let s = buildPaymentSchedule(f.estimate)!; assert.equal(s.canRelease, true); assert.equal(s.canInstall, false);
    assert.equal(s.next?.sequence, 101);
    f.pay(101, '100.00'); s = buildPaymentSchedule(f.estimate)!;
    assert.equal(s.canInstall, true); assert.equal(s.rows.find(row => row.sequence === 102)?.status, 'UPCOMING');
  });
  it('blocks installation when the added required installment has a refund under review', async () => {
    const f = fixture(); await f.sync(); f.estimate.order.status.name = 'Ready to pick up';
    f.pay(2, '500.00'); f.pay(3, '100.00'); f.pay(101, '100.00');
    Object.assign(f.estimate.payments.at(-1), { netPaidBaseAmount: '0.00', refundReviewPending: true, refundReviewBaseAmount: '100.00' });
    assert.equal(buildPaymentSchedule(f.estimate)!.canInstall, false);
  });
  it('makes the final part due only after completion', async () => {
    const f = fixture(); await f.sync(); f.estimate.order.status.name = 'Installed';
    const s = buildPaymentSchedule(f.estimate)!;
    assert.equal(s.rows.find(row => row.sequence === 102)?.status, 'DUE');
  });
  it('keeps the same percentages if the change is approved after installation', async () => {
    const f = fixture(); f.estimate.order.status.name = 'Installed'; await f.sync();
    assert.deepEqual(distribution(f.rows()), [['INSTALL', '100.00'], ['COMPLETE', '100.00']]);
    assert.ok(buildPaymentSchedule(f.estimate)!.rows.filter(row => row.sequence > 100).every(row => row.status === 'DUE'));
  });
  it('credits the existing deposit only once', async () => {
    const f = fixture(); f.estimate.payments[0].baseAmount = '250.00';
    f.estimate.payments.push({ id: 2, type: 'INSTALLATION_DEPOSIT', sequence: 1, status: 'PAID', baseAmount: '250.00' });
    await f.sync(); const s = buildPaymentSchedule(f.estimate)!;
    assert.equal(s.depositPaid, '250.00'); assert.equal(s.paid, '500.00'); assert.equal(s.balance, '900.00');
  });
});

describe('Installation Change Order preview before signature', () => {
  it('shows no immediately due charge before the installation milestone', async () => {
    const f = fixture(); await f.sync(); const before = JSON.stringify(f.estimate);
    const preview = await changeOrderPaymentPreview(f.db, 35, true);
    assert.deepEqual(preview, { dueAfterSigning: '0.00', remainingScheduled: '900.00', balance: '900.00', paid: '500.00' });
    assert.equal(JSON.stringify(f.estimate), before);
  });
  it('shows only the additional initial installation payment when original prerequisites were paid', async () => {
    const f = fixture(); await f.sync(); f.estimate.order.status.name = 'Ready to pick up'; f.pay(2, '500.00'); f.pay(3, '100.00');
    const preview = await changeOrderPaymentPreview(f.db, 35, true);
    assert.deepEqual(preview, { dueAfterSigning: '100.00', remainingScheduled: '200.00', balance: '300.00', paid: '1100.00' });
  });
  it('shows the initial portion now for a project-percentage plan', async () => {
    const f = fixture(project); await f.sync(); const preview = await changeOrderPaymentPreview(f.db, 35, true);
    assert.equal(preview?.dueAfterSigning, '100.00'); assert.equal(preview?.remainingScheduled, '700.00');
  });
  it('does not read or expose a dealer payment schedule on an external customer link', async () => {
    const db: any = { estimate: { findUnique: () => { throw new Error('No internal prices may be read'); } } };
    assert.equal(await changeOrderPaymentPreview(db, 35, false), null);
  });
  it('does not substitute a live schedule for a pending material proposal', async () => {
    const f = fixture(); await f.sync(); f.estimate.materialRevisions = [{ id: 7, activeSlot: 1 }];
    assert.equal(await changeOrderPaymentPreview(f.db, 35, true), null);
  });
  it('does not show approved amounts when the installation quote is still a draft', async () => {
    const f = fixture(); f.estimate.installationJob.quotes[0].status = 'DRAFT';
    assert.equal(await changeOrderPaymentPreview(f.db, 35, true), null);
  });
});

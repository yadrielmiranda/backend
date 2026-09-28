import * as assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { materialChangeInstallments } from './material-change-installments';
import { buildPaymentSchedule, installmentContext, synchronizeScheduleChanges } from './payment-schedule';
import { PlanSnapshot, planRows, ScheduleAmounts } from './payment-plan';
import { materialChangePreview } from '@/contracts/material-change-preview';
import { assertMaterialReadyForFactory } from '@/estimates/material-revisions/material-revision-policy';

const amounts = (material: string, installation = '0.00', city = '0.00'): ScheduleAmounts => ({ material, installation, permit: '0.00', city });
const plan = (): PlanSnapshot => ({ version: 1, planId: 2, name: 'Test', definition: {
  withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 50 }, { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 }],
  withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 50 }, { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 }, { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 }],
} });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture() {
  const snapshot = plan();
  snapshot.locked = { amounts: amounts('118.15'), rows: planRows(snapshot, amounts('118.15'), false), at: '2026-09-26T12:00:00Z' };
  const estimate: any = { id: 35, idUser: 7, number: 'TEST', status: { name: 'Ordered' }, units: 2,
    order: { status: { name: 'Pending' }, poNumber: null, rateReal: null },
    totalPayable: '314.67', customerTotalPayable: '314.67', dealerModeSnapshot: 'INTERNAL',
    installationJob: null, materialRevisions: [], pieces: [], paymentPlanSnapshot: snapshot,
    payments: [{ id: 9, type: 'INSTALLMENT', sequence: 1, status: 'PAID', baseAmount: '59.08' }],
  };
  const db: any = { estimate: {
    findUnique: async () => estimate, findUniqueOrThrow: async () => estimate,
    update: async ({ data }: any) => Object.assign(estimate, data),
  } };
  return { estimate, db };
}
describe('Material change installments', () => {
  it('splits the reported 196.52 change into 98.26 due now and 98.26 at release', async () => {
    const f = fixture(); const paid = copy(f.estimate.payments); const locked = copy(f.estimate.paymentPlanSnapshot.locked);
    await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true, materialRevisionId: 10 });
    const schedule = buildPaymentSchedule(f.estimate)!;
    assert.equal(schedule.next?.amount, '98.26'); assert.equal(schedule.next?.milestone, 'ORDER');
    assert.equal(schedule.total, '314.67'); assert.equal(schedule.paid, '59.08'); assert.equal(schedule.balance, '255.59');
    assert.equal(schedule.rows.find(row => row.sequence === 102)?.balance, '98.26');
    assert.equal(schedule.rows.find(row => row.sequence === 2)?.balance, '59.07');
    assert.deepEqual(f.estimate.payments, paid); assert.deepEqual(f.estimate.paymentPlanSnapshot.locked, locked);
    assert.ok(schedule.rows.find(row => row.sequence === 101)?.materialRevision);
    const saved = JSON.stringify(f.estimate.paymentPlanSnapshot);
    await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true, materialRevisionId: 10 });
    assert.equal(JSON.stringify(f.estimate.paymentPlanSnapshot), saved);
  });
  it('credits payment of only the additional initial installment, leaving release unpaid', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    f.estimate.payments.push({ type: 'INSTALLMENT', sequence: 101, status: 'PAID', baseAmount: '98.26' });
    const schedule = buildPaymentSchedule(f.estimate)!;
    assert.equal(schedule.paid, '157.34'); assert.equal(schedule.balance, '157.33'); assert.equal(schedule.next, null);
    assert.equal(schedule.canRelease, false);
  });
  it('respects a 50/40/10 project plan instead of hardcoding 50/50', () => {
    const rows = materialChangeInstallments(plan(), amounts('100', '100'), amounts('296.52', '100'), true, 101, 1);
    assert.deepEqual(rows.map(row => [row.milestone, row.amount]), [['ORDER', '98.26'], ['RELEASE', '78.61'], ['COMPLETE', '19.65']]);
  });
  it('keeps the final rounding cent on the last installment', () => {
    const rows = materialChangeInstallments(plan(), amounts('0.00'), amounts('196.53'), false, 101, 1);
    assert.deepEqual(rows.map(row => row.amount), ['98.27', '98.26']);
  });
  it('preserves exact totals across 200 different cent amounts', () => {
    for (let cents = 1; cents <= 200; cents++) {
      const delta = new Decimal(cents).div(100).toFixed(2);
      const rows = materialChangeInstallments(plan(), amounts('0.00'), amounts(delta), false, 101, 1);
      assert.equal(rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2), delta);
    }
  });
  it('supports 100 percent upfront material plans', () => {
    const p = plan(); p.definition.withoutInstallation = [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }];
    assert.deepEqual(materialChangeInstallments(p, amounts('118.15'), amounts('314.67'), false, 101, 1).map(r => [r.milestone, r.amount]), [['ORDER', '196.52']]);
  });
  it('keeps material and installation percentages on their respective milestones', () => {
    const p = plan(); p.definition.withInstallation = [
      { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 }, { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
      { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 50 }, { milestone: 'COMPLETE', basis: 'INSTALLATION', percent: 50 },
    ];
    const rows = materialChangeInstallments(p, amounts('100', '100'), amounts('300', '180'), true, 101, 1);
    assert.deepEqual(rows.map(r => [r.milestone, r.amount]), [['ORDER', '100.00'], ['RELEASE', '100.00'], ['INSTALL', '40.00'], ['COMPLETE', '40.00']]);
  });
  it('represents reductions as credits without new charges', () => {
    const rows = materialChangeInstallments(plan(), amounts('300'), amounts('100'), false, 101, 1);
    assert.deepEqual(rows.map(r => r.amount), ['-100.00', '-100.00']);
  });
  it('does not bill a zero-price specification change', () => {
    assert.equal(materialChangeInstallments(plan(), amounts('100'), amounts('100'), false, 101, 1)[0].amount, '0.00');
  });
  it('keeps City Fee as a separate approval item', async () => {
    const f = fixture();
    f.estimate.installationJob = { status: 'MATERIAL_PAID', quotes: [{ status: 'APPROVED', total: '0' }], permit: { cityFee: '20', permitFeeSnapshot: '0' } };
    await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    assert.equal(f.estimate.paymentPlanSnapshot.adjustments.at(-1).kind, 'CITY_FEE');
    assert.equal(f.estimate.paymentPlanSnapshot.adjustments.at(-1).amount, '20.00');
    assert.equal(buildPaymentSchedule(f.estimate)!.total, '334.67');
  });
  it('also uses the plan for ordinary adjustments without labeling them material revisions', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35);
    assert.equal(f.estimate.paymentPlanSnapshot.adjustments.length, 2);
    assert.equal(f.estimate.paymentPlanSnapshot.adjustments[0].milestone, 'ORDER');
    assert.equal(f.estimate.paymentPlanSnapshot.adjustments[0].materialRevision, undefined);
  });
  it('blocks an actual payment while signature/revision is pending', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    f.estimate.materialRevisions = [{ id: 10, activeSlot: 1 }];
    await assert.rejects(() => installmentContext(f.db, 35, 101, false), /pending material revision/);
  });
  it('prevents factory submission until the new initial installment is covered', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    f.estimate.materialRevisions = [{ id: 10, status: 'APPLIED', activeSlot: null }];
    await assert.rejects(() => assertMaterialReadyForFactory(f.db, 35), /additional initial installment/);
    f.estimate.payments.push({ type: 'INSTALLMENT', sequence: 101, status: 'PAID', baseAmount: '98.26' });
    await assert.doesNotReject(() => assertMaterialReadyForFactory(f.db, 35));
  });
  it('does not confuse an applied revision with a pending signature', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    f.estimate.materialRevisions = [{ id: 10, activeSlot: null, status: 'APPLIED' }];
    assert.equal(buildPaymentSchedule(f.estimate)!.materialRevisionPending, false);
    assert.equal(buildPaymentSchedule(f.estimate)!.next?.sequence, 101);
  });
  it('keeps a previously paid deposit credited without charging a new deposit', async () => {
    const f = fixture(); f.estimate.order = null; f.estimate.status.name = 'Active';
    f.estimate.payments = [{ type: 'INSTALLATION_DEPOSIT', sequence: 1, status: 'PAID', baseAmount: '250.00' }];
    await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    const schedule = buildPaymentSchedule(f.estimate)!;
    assert.equal(schedule.depositPaid, '250.00'); assert.equal(schedule.balance, '64.67');
    assert.equal(f.estimate.payments.length, 1);
  });
});

describe('Public pre-signature payment summary', () => {
  it('shows the additional total and initial amount before signature without changing live data', async () => {
    const f = fixture(); await synchronizeScheduleChanges(f.db, 35, { approvedMaterialRevision: true });
    const proposedPlan = copy(f.estimate.paymentPlanSnapshot);
    f.estimate.paymentPlanSnapshot.adjustments = []; f.estimate.customerTotalPayable = '118.15';
    f.estimate.materialRevisions = [{ id: 10, activeSlot: 1 }];
    f.db.materialRevision = { findFirst: async () => ({ status: 'AWAITING_SIGNATURE', activeSlot: 1,
      originalSummary: { customerProjectTotal: '118.15' }, revisedSummary: { customerProjectTotal: '314.67' },
      proposal: { totals: { customerTotalPayable: '314.67' }, paymentPlanSnapshot: proposedPlan, pieces: [], installation: null },
    }) };
    const before = JSON.stringify(f.estimate);
    const preview = await materialChangePreview(f.db, 35, 10, true);
    assert.equal(preview?.difference, '196.52'); assert.equal(preview?.paymentPreview?.dueAfterSigning, '98.26');
    assert.equal(preview?.paymentPreview?.remainingScheduled, '157.33'); assert.equal(preview?.paymentPreview?.paid, '59.08');
    assert.equal(JSON.stringify(f.estimate), before);
  });
  it('does not disclose dealer payment amounts on an external customer link', async () => {
    const f = fixture(); f.db.estimate.findUnique = async () => { throw new Error('No internal price lookup expected'); };
    f.db.materialRevision = { findFirst: async () => ({ status: 'AWAITING_SIGNATURE', activeSlot: 1, proposal: {},
      originalSummary: { customerProjectTotal: '100', material: '40' }, revisedSummary: { customerProjectTotal: '200', material: '70' } }) };
    const preview = await materialChangePreview(f.db, 35, 10, false);
    assert.equal(preview?.difference, '100.00'); assert.equal(preview?.paymentPreview, null);
  });
});

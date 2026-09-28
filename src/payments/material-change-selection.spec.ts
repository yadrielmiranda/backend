import * as assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { PaymentsService } from './payments.service';
import { installmentContext, buildPaymentSchedule } from '@/payment-plans/payment-schedule';
import { planRows } from '@/payment-plans/payment-plan';
import { materialChangeInstallments } from '@/payment-plans/material-change-installments';

function fixture() {
  const amounts = { material: '118.15', installation: '0.00', permit: '0.00', city: '0.00' };
  const plan: any = { version: 1, definition: { withoutInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 }, { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
  ] } };
  plan.locked = { rows: planRows(plan, amounts, false), amounts, at: '2026-09-26' };
  plan.adjustments = materialChangeInstallments(plan, amounts, { ...amounts, material: '314.67' }, false, 101, 1);
  const estimate: any = { id: 35, idUser: 7, units: 2, dealerModeSnapshot: 'INTERNAL', status: { name: 'Ordered' },
    order: { status: { name: 'Pending' }, deliveries: [], extraCharges: [] }, materialRevisions: [],
    totalPayable: '314.67', customerTotalPayable: '314.67', paymentPlanSnapshot: plan,
    payments: [{ type: 'INSTALLMENT', sequence: 1, status: 'PAID', baseAmount: '59.08' }],
  };
  const tx: any = { estimate: { findUnique: async () => estimate, findUniqueOrThrow: async () => estimate }, $queryRaw: async () => [{ id: 35 }] };
  const service: any = Object.create(PaymentsService.prototype);
  service.findPublicEstimateForPayment = async () => ({ estimate });
  const contexts: any[] = [];
  service.installationWorkflow = { getPaymentContext: async (_id: number, _type: string, sequence: number, _accepted: any, _user: any, _tx: any, options: any) => {
    const context = await installmentContext(tx, 35, sequence, options.preview, options.allowAdvance);
    const result = { estimate, paymentSequence: sequence, baseAmount: new Decimal(context.row.balance), surchargePercent: new Decimal(0),
      surchargeAmount: new Decimal(0), totalAmount: new Decimal(context.row.balance), description: context.row.description };
    contexts.push({ sequence, options }); return result;
  } };
  return { estimate, tx, service, contexts, call: (items: any[], expectedBalance: number, userId = 7) => service.selectedPaymentContexts(tx,
    { estimateId: 35, type: 'INSTALLMENT', items, publicToken: 'customer', expectedBalance }, { id: userId }, true) };
}
const item = (sequence: number) => ({ type: 'INSTALLMENT', sequence });

describe('Public individual selection of approved installment advances', () => {
  it('offers the additional initial installment as due, not only as full balance', async () => {
    const f = fixture(); const options = await f.service.publicPaymentOptions(f.tx, f.estimate, buildPaymentSchedule(f.estimate));
    assert.equal(options.payments.find((p: any) => p.sequence === 101)?.advanceOnly, false);
    assert.equal(options.payments.find((p: any) => p.sequence === 2)?.advanceOnly, true);
    assert.equal(options.payments.find((p: any) => p.sequence === 102)?.advanceOnly, true);
  });
  it('can pay just the additional 98.26 initial installment', async () => {
    const f = fixture(); const rows = await f.call([item(101)], 98.26);
    assert.equal(rows.length, 1); assert.equal(rows[0].baseAmount.toFixed(2), '98.26');
    assert.equal(rows[0].paymentSequence, 101);
  });
  it('can advance just one release installment without forcing the others', async () => {
    const f = fixture(); const rows = await f.call([item(102)], 98.26);
    assert.equal(rows.length, 1); assert.equal(rows[0].paymentSequence, 102);
    assert.equal(f.contexts.at(-1).options.allowAdvance, true);
  });
  it('can select the original release without paying the new adjustment', async () => {
    const rows = await fixture().call([item(2)], 59.07); assert.equal(rows.length, 1); assert.equal(rows[0].paymentSequence, 2);
  });
  it('can select both change installments but leave original release unchecked', async () => {
    const rows = await fixture().call([item(101), item(102)], 196.52);
    assert.deepEqual(rows.map((row: any) => row.paymentSequence), [101, 102]);
  });
  it('rejects a stale amount', async () => { await assert.rejects(() => fixture().call([item(101)], 98.25), /balance changed/); });
  it('rejects duplicate items', async () => { await assert.rejects(() => fixture().call([item(101), item(101)], 196.52), /distinct/); });
  it('rejects a different owner', async () => { await assert.rejects(() => fixture().call([item(101)], 98.26, 99), /not found/); });
  it('rejects an unknown installment', async () => { await assert.rejects(() => fixture().call([item(999)], 98.26), /no longer available/); });
  it('rejects an empty selection', async () => { await assert.rejects(() => fixture().call([], 0), /distinct/); });
  it('does not allow future payments during refund review', async () => {
    const f = fixture(); f.estimate.payments[0].refundReviewPending = true;
    await assert.rejects(() => f.call([item(102)], 98.26), /no longer available/);
  });
});

describe('Public payment availability during a material revision', () => {
  it('keeps the due installment visible and exposes the pending flag while checkout remains blocked', async () => {
    const f = fixture(); f.estimate.materialRevisions = [{ id: 8 }];
    const options = await f.service.publicPaymentOptions(f.tx, f.estimate, buildPaymentSchedule(f.estimate));
    assert.equal(options.materialRevisionPending, true);
    assert.equal(options.payments.find((p: any) => p.sequence === 101)?.baseAmount, '98.26');
    assert.equal(options.fullBalance, null);
    await assert.rejects(() => installmentContext(f.tx, 35, 101, false), /pending material revision/);
  });
  it('restores normal availability once the active material revision is removed', async () => {
    const f = fixture();
    const initial = await f.service.publicPaymentOptions(f.tx, f.estimate, buildPaymentSchedule(f.estimate));
    assert.equal(initial.materialRevisionPending, false);
    f.estimate.materialRevisions = [{ id: 8 }];
    const paused = await f.service.publicPaymentOptions(f.tx, f.estimate, buildPaymentSchedule(f.estimate));
    assert.equal(paused.materialRevisionPending, true);
    f.estimate.materialRevisions = [];
    const restored = await f.service.publicPaymentOptions(f.tx, f.estimate, buildPaymentSchedule(f.estimate));
    assert.deepEqual(restored, initial);
    const payment = await installmentContext(f.tx, 35, 101, false);
    assert.equal(payment.row.balance, '98.26');
  });
  it('exposes a pending revision for legacy payments without a payment schedule', async () => {
    const f = fixture(); f.estimate.materialRevisions = [{ id: 8 }];
    f.estimate.paymentPlanSnapshot = null; f.estimate.order = null; f.estimate.status.name = 'Active';
    f.service.installationWorkflow.getPaymentContext = async () => ({
      paymentSequence: 1, baseAmount: new Decimal('314.67'), surchargePercent: new Decimal(0),
      surchargeAmount: new Decimal(0), totalAmount: new Decimal('314.67'), description: 'Material payment',
    });
    const options = await f.service.publicPaymentOptions(f.tx, f.estimate, null);
    assert.equal(options.materialRevisionPending, true);
    assert.equal(options.payments[0]?.type, 'MATERIAL');
    assert.equal(options.payments[0]?.baseAmount, '314.67');
    f.estimate.materialRevisions = [];
    const restored = await f.service.publicPaymentOptions(f.tx, f.estimate, null);
    assert.equal(restored.materialRevisionPending, false);
    assert.deepEqual(restored.payments, options.payments);
  });
});

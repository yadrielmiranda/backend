import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { attachLedgerStore } from './testing/ledger-store';
import { freezeProcessingCostSnapshot, singleProcessingComponent } from './processing-cost-snapshot';

const money = (value: string | number) => new Prisma.Decimal(value);
const snapshot = (amount: string) => freezeProcessingCostSnapshot({ baseAmount: amount, surchargeAmount: '0', totalAmount: amount,
  processingComponents: singleProcessingComponent('material', amount) });

function fixture() {
  const estimate: any = { id: 7, materialProcessingCost: money(0), materialProcessingCostPending: false,
    order: null, installationJob: null, status: { name: 'Active' }, user: { role: { name: 'dealer' } } };
  const payments: any[] = ['5320.64', '2679.36'].map((amount, index) => ({
    id: index + 1, idEst: 7, type: 'INSTALLMENT', sequence: index + 1, status: 'PENDING',
    stripeSessionId: 'cs_first', stripePaymentIntentId: null, currency: 'usd',
    amount: money(amount), baseAmount: money(amount), originalBaseAmount: money('5320.64'), surchargeAmount: money(0),
    processingCostSnapshot: snapshot(amount), paidAt: null, refundedAmount: money(0), refundCreditAmount: money(0),
    refundReviewBaseAmount: money(0), refundReviewPending: false,
  }));
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    estimate: { update: jest.fn(async ({ data }) => Object.assign(estimate, data)) },
    payment: {
      findMany: jest.fn(async ({ where }) => payments.filter(payment => payment.stripeSessionId === where.stripeSessionId).map(payment => ({ ...payment, estimate }))),
      findUnique: jest.fn(async ({ where }) => {
        const payment = payments.find(payment => payment.id === where.id);
        return payment ? { ...payment, estimate } : null;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(payments.find(payment => payment.id === where.id), data)),
    },
  };
  const ledger = attachLedgerStore(tx, () => payments);
  const service = new PaymentsService(tx, { get: () => 'sk_test_in_memory' } as any, {} as any,
    { createAndSendToRoles: jest.fn(async () => []) } as any);
  const effects = jest.spyOn(service as any, 'ensurePaidPaymentEffects').mockResolvedValue(false);
  const refunds: any[] = [];
  const charge: any = { id: 'ch_first', payment_intent: 'pi_first', status: 'succeeded', paid: true, captured: true,
    currency: 'usd', created: 1700000000, amount_captured: 800000, balance_transaction: { id: 'txn_first', currency: 'usd', fee: 500 },
    payment_method_details: { type: 'card' } };
  (service as any).stripe = {
    paymentIntents: { retrieve: jest.fn(async () => ({ status: 'succeeded', latest_charge: charge })) },
    refunds: { list: jest.fn(async () => ({ data: refunds, has_more: false })) },
    balanceTransactions: { retrieve: jest.fn(async () => { throw new Error('Unexpected external fee lookup'); }) },
  };
  const session: any = { id: 'cs_first', status: 'complete', payment_status: 'paid', payment_intent: 'pi_first',
    amount_total: 800000, currency: 'usd' };
  const startNext = (payment: any, amount: string, id = 'cs_second') => Object.assign(payment, {
    status: 'PENDING', stripeSessionId: id, stripePaymentIntentId: null,
    amount: money(amount), baseAmount: money(amount), processingCostSnapshot: snapshot(amount), paidAt: null,
  });
  return { estimate, payments, ledger, effects, charge, session, refunds, tx,
    confirm: () => (service as any).processPaidCheckoutSession(tx, session), startNext };
}

describe('Checkout replay after a partially paid installment starts another checkout', () => {
  it('uses both original receipts when only one Payment still points to the $8000 session', async () => {
    const f = fixture(); await f.confirm();
    const original = f.ledger.receipts.map(receipt => JSON.stringify(receipt.processingCostSnapshot));
    f.startNext(f.payments[1], '2641.28'); f.effects.mockClear();
    await expect(f.confirm()).resolves.toBe(true);
    expect(f.ledger.receipts).toHaveLength(2);
    expect(f.ledger.receipts.map(receipt => JSON.stringify(receipt.processingCostSnapshot))).toEqual(original);
    expect(f.payments[1]).toMatchObject({ status: 'PENDING', stripeSessionId: 'cs_second', stripePaymentIntentId: null });
    expect(f.payments[1].baseAmount.toFixed(2)).toBe('2641.28');
    expect(f.payments[1].netPaidBaseAmount.toFixed(2)).toBe('2679.36');
    expect(f.effects.mock.calls.map(call => (call[1] as any).id)).toEqual([1]);
    expect(f.ledger.processingCosts).toHaveLength(1);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('5.00');
  });

  it('finds the paid session after every Payment has moved to a later attempt', async () => {
    const f = fixture(); await f.confirm();
    f.startNext(f.payments[0], '100.00', 'cs_third'); f.startNext(f.payments[1], '2641.28');
    f.effects.mockClear();
    await expect(f.confirm()).resolves.toBe(true);
    expect(f.ledger.receipts).toHaveLength(2); expect(f.effects).not.toHaveBeenCalled();
    expect(f.payments.map(payment => payment.stripeSessionId)).toEqual(['cs_third', 'cs_second']);
  });

  it('reconciles a refund of the first charge against its original receipts while preserving the second attempt', async () => {
    const f = fixture(); await f.confirm(); f.startNext(f.payments[1], '2641.28');
    f.refunds.push({ id: 're_first', amount: 100000, currency: 'usd', status: 'succeeded', created: 1700000001,
      balance_transaction: { id: 'txn_refund', fee: 0, currency: 'usd' } });
    f.effects.mockClear(); await f.confirm(); await f.confirm();
    expect(f.ledger.refunds).toHaveLength(1); expect(f.ledger.allocations).toHaveLength(2);
    expect(f.payments[0].netPaidBaseAmount.toFixed(2)).toBe('4655.56');
    expect(f.payments[1].netPaidBaseAmount.toFixed(2)).toBe('2344.44');
    expect(f.payments[1]).toMatchObject({ status: 'PENDING', stripeSessionId: 'cs_second', refundReviewPending: true });
    expect(f.effects.mock.calls.some(call => (call[1] as any).id === 2)).toBe(false);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('5.00');
    expect(f.ledger.processingCosts).toHaveLength(1);
  });

  it.each(['amount', 'currency', 'charge'])('rejects a replay with inconsistent %s without rewriting receipts', async field => {
    const f = fixture(); await f.confirm(); f.startNext(f.payments[1], '2641.28');
    const before = JSON.stringify(f.ledger.receipts);
    if (field === 'amount') f.session.amount_total++;
    if (field === 'currency') f.session.currency = 'eur';
    if (field === 'charge') f.charge.id = 'ch_wrong';
    await expect(f.confirm()).rejects.toThrow(/original receipts/);
    expect(JSON.stringify(f.ledger.receipts)).toBe(before);
    expect(f.payments[1]).toMatchObject({ status: 'PENDING', stripeSessionId: 'cs_second' });
  });
});

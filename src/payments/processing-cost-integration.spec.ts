import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { attachLedgerStore } from './testing/ledger-store';
import { freezeProcessingCostSnapshot, singleProcessingComponent } from './processing-cost-snapshot';

const decimal = (value: string | number) => new Prisma.Decimal(value);

// Production checkout confirmation, receipt ledger, cost reconciliation and payment
// effects run together. Every persistence and Stripe method is an in-memory double.
function fixture({ mixed = false, surcharge = '0.00', historical = false } = {}) {
  const estimate: any = { id: 7, idUser: 9, number: '190007', status: { name: 'Active' },
    dealerModeSnapshot: 'EXTERNAL', order: null, manualDiscount: null, paymentPlanSnapshot: null,
    installationJob: { id: 2, status: 'MATERIAL_PAYMENT_PENDING', quotes: [] },
    materialProcessingCost: decimal(0), materialProcessingCostPending: false,
    user: { id: 9, role: { name: 'dealer' }, firstName: 'Fixture', lastName: 'Buyer', email: null, phone: null } };
  const amounts = mixed ? ['80.00', '20.00'] : ['100.00'];
  const payments: any[] = amounts.map((amount, index) => {
    const fee = index === 0 ? surcharge : '0.00';
    const total = decimal(amount).plus(fee);
    return { id: 10 + index, idEst: 7, userId: 9, type: index ? 'INSTALLATION' : 'MATERIAL', sequence: 1,
      status: 'PENDING', currency: 'usd', baseAmount: decimal(amount), amount: total,
      surchargeAmount: decimal(fee), surchargePercent: decimal(0),
      stripeSessionId: 'cs_fixture', stripePaymentIntentId: null, stripeCustomerId: null,
      paidAt: null, originalBaseAmount: null, refundedAmount: decimal(0), refundCreditAmount: decimal(0),
      refundReviewBaseAmount: decimal(0), refundReviewPending: false, installationJobId: 2,
      payerType: 'ACCOUNT_OWNER', payerName: 'Fixture buyer',
      processingCostSnapshot: historical ? null : freezeProcessingCostSnapshot({
        baseAmount: amount, surchargeAmount: fee, totalAmount: total,
        processingComponents: singleProcessingComponent(index ? 'installation' : 'material', amount),
      }),
    };
  });
  estimate.payments = payments;
  const paymentView = (payment: any) => payment ? { ...payment, estimate, order: null } : null;
  const matchPayment = (where: any) => payments.find(payment => where.idEst_type_sequence
    ? payment.idEst === where.idEst_type_sequence.idEst && payment.type === where.idEst_type_sequence.type && payment.sequence === where.idEst_type_sequence.sequence
    : payment.id === where.id);
  const apply = (payment: any, data: any) => {
    const values = { ...data };
    if (values.processingCostSnapshot === Prisma.DbNull) values.processingCostSnapshot = null;
    return Object.assign(payment, values);
  };
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    estimate: {
      findUnique: jest.fn(async () => estimate), findUniqueOrThrow: jest.fn(async () => estimate),
      update: jest.fn(async ({ data }) => {
        Object.assign(estimate, data);
        if (data.statusId === 3) estimate.status = { id: 3, name: 'Pending order review' };
        return estimate;
      }),
    },
    payment: {
      findMany: jest.fn(async ({ where }) => payments.filter(payment => payment.stripeSessionId === where.stripeSessionId).map(paymentView)),
      findUnique: jest.fn(async ({ where }) => paymentView(matchPayment(where))),
      update: jest.fn(async ({ where, data }) => apply(matchPayment(where), data)),
      updateMany: jest.fn(async ({ where, data }) => {
        const selected = payments.filter(payment => payment.idEst === where.idEst && payment.stripePaymentIntentId === where.stripePaymentIntentId);
        selected.forEach(payment => apply(payment, data)); return { count: selected.length };
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        const existing = matchPayment(where);
        if (existing) return apply(existing, update);
        const payment = { id: 10 + payments.length, ...create }; payments.push(payment); return payment;
      }),
    },
    order: { findUnique: jest.fn(async () => null) },
    estimateStatus: { upsert: jest.fn(async () => ({ id: 3, name: 'Pending order review' })) },
    eventLog: { create: jest.fn(async () => ({})) },
  };
  tx.$transaction = jest.fn(async (work: any) => work(tx));
  const ledger = attachLedgerStore(tx, () => payments);
  const notifications = { createAndSend: jest.fn(async (..._args: any[]) => ({})), createAndSendToRoles: jest.fn(async (..._args: any[]) => []) };
  const workflow = { markPaymentPaid: jest.fn(async () => false) };
  const config: any = { get: (key: string) => key === 'STRIPE_SECRET_KEY' ? 'sk_test_only_memory' : key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_fixture' : undefined };
  const service = new PaymentsService(tx, config, workflow as any, notifications as any);
  const refunds: any[] = [];
  const charge: any = { id: 'ch_fixture', object: 'charge', payment_intent: 'pi_fixture', paid: true, captured: true,
    amount_captured: payments.reduce((sum, payment) => sum + Number(payment.amount.mul(100)), 0),
    currency: 'usd', created: 1700000000, balance_transaction: 'txn_fixture', payment_method_details: { type: 'card' } };
  const session: any = { id: 'cs_fixture', status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixture', amount_total: charge.amount_captured, currency: 'usd' };
  let webhook: any;
  const stripe = {
    paymentIntents: { retrieve: jest.fn(async () => ({ status: 'succeeded', latest_charge: charge })) },
    charges: { retrieve: jest.fn(async () => charge) },
    refunds: { list: jest.fn(async () => ({ data: refunds, has_more: false })) },
    balanceTransactions: { retrieve: jest.fn(async () => ({ id: 'txn_fixture', fee: 300, currency: 'usd' })) },
    checkout: { sessions: { retrieve: jest.fn(async () => session), list: jest.fn(async () => ({ data: [session] })) } },
    webhooks: { constructEvent: jest.fn(() => webhook) },
  };
  (service as any).stripe = stripe;
  return { tx, estimate, payments, ledger, notifications, workflow, service, charge, session, stripe, refunds,
    confirm: () => (service as any).processPaidCheckoutSession(tx, session),
    event: async (type = 'charge.updated') => {
      webhook = { type, data: { object: charge } };
      return service.handleStripeWebhook(Buffer.from('simulated'), 'simulated_signature');
    },
    costs: () => tx.stripeProcessingCost.findMany({ where: { estimateId: estimate.id } }),
  };
}

describe('Processing cost integration with confirmed payments', () => {
  it('copies the checkout snapshot to the immutable receipt and records the cost once', async () => {
    const f = fixture(); const saved = structuredClone(f.payments[0].processingCostSnapshot);
    await expect(f.confirm()).resolves.toBe(true);
    expect(f.payments[0].status).toBe('PAID');
    expect(f.ledger.receipts).toHaveLength(1);
    expect(f.ledger.receipts[0].processingCostSnapshot).toEqual(saved);
    expect(await f.costs()).toHaveLength(1);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('3.00');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(f.workflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.notifications.createAndSend.mock.calls)).not.toContain('txn_fixture');
    expect(JSON.stringify(f.notifications.createAndSendToRoles.mock.calls.map(call => call[1]))).not.toContain('processingCost');
  });

  it('allocates one capture fee across mixed receipts without duplication', async () => {
    const f = fixture({ mixed: true }); await f.confirm();
    expect(f.ledger.receipts).toHaveLength(2);
    expect(await f.costs()).toHaveLength(1);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('2.40');
    expect(f.stripe.balanceTransactions.retrieve).toHaveBeenCalledTimes(1);
    expect(f.payments.every(payment => payment.status === 'PAID')).toBe(true);
  });

  it('commits PAID and workflow effects while missing cost remains pending, then resolves through charge.updated', async () => {
    const f = fixture(); f.charge.balance_transaction = null;
    await f.confirm();
    expect(f.payments[0].status).toBe('PAID');
    expect(f.workflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(f.estimate.status.name).toBe('Pending order review');
    expect(f.estimate.materialProcessingCostPending).toBe(true);
    expect((await f.costs())[0].status).toBe('PENDING');
    f.charge.balance_transaction = 'txn_fixture';
    await expect(f.event()).resolves.toEqual({ received: true });
    await f.event();
    expect(await f.costs()).toHaveLength(1);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('3.00');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
    expect(f.stripe.balanceTransactions.retrieve).toHaveBeenCalledTimes(1);
    expect(f.workflow.markPaymentPaid).toHaveBeenCalledTimes(1);
  });

  it('does not turn a processor-cost lookup error into a failed customer payment', async () => {
    const f = fixture(); f.stripe.balanceTransactions.retrieve.mockRejectedValue(new Error('sensitive simulated provider failure'));
    await expect(f.confirm()).resolves.toBe(true);
    expect(f.payments[0].status).toBe('PAID'); expect(f.workflow.markPaymentPaid).toHaveBeenCalled();
    expect(f.estimate.materialProcessingCostPending).toBe(true);
    expect((await f.costs())[0].lastError).toBe('Stripe processing cost is not available yet.');
    expect(JSON.stringify(f.notifications.createAndSendToRoles.mock.calls.map(call => call[1]))).not.toContain('sensitive');
  });

  it('replays confirmation using the original receipt snapshot, not changed Payment metadata', async () => {
    const f = fixture(); await f.confirm();
    const saved = JSON.stringify(f.ledger.receipts[0].processingCostSnapshot);
    f.payments[0].processingCostSnapshot = freezeProcessingCostSnapshot({ baseAmount: '100', surchargeAmount: '0', totalAmount: '100',
      processingComponents: singleProcessingComponent('installation', '100') });
    await f.confirm();
    expect(f.ledger.receipts).toHaveLength(1); expect(await f.costs()).toHaveLength(1);
    expect(JSON.stringify(f.ledger.receipts[0].processingCostSnapshot)).toBe(saved);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('3.00');
    expect(f.stripe.balanceTransactions.retrieve).toHaveBeenCalledTimes(1);
    expect(f.tx.eventLog.create).toHaveBeenCalledTimes(1);
  });

  it('leaves historic captures without processing snapshots outside new cost accounting', async () => {
    const f = fixture({ historical: true });
    await f.confirm(); await f.event();
    expect(f.payments[0].status).toBe('PAID');
    expect(f.ledger.receipts).toHaveLength(1); expect(await f.costs()).toHaveLength(0);
    expect(f.stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('0.00');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
  });

  it('retains actual processor cost after refund and subtracts only surcharge still collected', async () => {
    const f = fixture({ surcharge: '3.00' }); await f.confirm();
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('0.00');
    f.refunds.push({ id: 're_half', object: 'refund', amount: 5150, currency: 'usd', created: 1700000001,
      status: 'succeeded', balance_transaction: { id: 'txn_refund', fee: 0, currency: 'usd' } });
    await f.event('charge.refunded'); await f.event('charge.refunded');
    expect(f.ledger.refunds).toHaveLength(1); expect(f.ledger.allocations).toHaveLength(1);
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('1.50');
    expect((await f.costs())[0].fee.toFixed(2)).toBe('3.00');
    expect(f.payments[0].netPaidBaseAmount.toFixed(2)).toBe('50.00');
  });

  it('clears pending Stripe metadata when a verified manual payment replaces an unused checkout', async () => {
    const f = fixture(); const payment = f.payments[0];
    payment.status = 'CANCELED'; payment.stripeSessionId = null;
    const context = { estimate: f.estimate, job: f.estimate.installationJob, type: 'MATERIAL', paymentSequence: 1,
      baseAmount: decimal(100), surchargeAmount: decimal(0), surchargePercent: decimal(0), totalAmount: decimal(100), description: 'Material' };
    jest.spyOn(f.service as any, 'selectedPaymentContexts').mockResolvedValue([context]);
    await f.service.recordManualPayment({ estimateId: 7, type: 'MATERIAL', method: 'CHECK', reference: 'check-123',
      fundsVerified: true, actor: { id: 1, role: { name: 'admin' } } as any });
    expect(f.tx.payment.upsert.mock.calls[0][0].update.processingCostSnapshot).toBe(Prisma.DbNull);
    expect(payment.processingCostSnapshot).toBeNull(); expect(payment.status).toBe('PAID');
    expect(f.ledger.receipts[0]).not.toHaveProperty('processingCostSnapshot');
    expect(await f.costs()).toHaveLength(0); expect(f.stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
  });
});

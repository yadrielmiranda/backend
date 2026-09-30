import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { reconcileStripeProcessingCost } from './processing-costs';

const decimal = (value: string | number) => new Prisma.Decimal(value);
const keys = ['material', 'installation', 'permit', 'city', 'other'] as const;
const snapshot = (parts: Partial<Record<(typeof keys)[number], string>>, surcharge = '0.00') => ({
  version: 1,
  components: Object.fromEntries(keys.map(key => [key, parts[key] ?? '0.00'])),
  total: Object.values(parts).reduce((total, value) => total.plus(value!), decimal(0)).toFixed(2),
  materialSurcharge: surcharge,
});
function receipt(id: number, parts: Partial<Record<(typeof keys)[number], string>>, surcharge = '0.00', materialSurcharge = '0.00') {
  const saved = snapshot(parts, materialSurcharge);
  return { id, stripeChargeId: 'ch_test', amount: decimal(saved.total), surchargeAmount: decimal(surcharge),
    currency: 'usd', processingCostSnapshot: saved as any, payment: { idEst: 7 }, allocations: [] as any[] };
}
const balance = (id: string, fee: number, currency = 'usd') => ({ id, fee, currency }) as Stripe.BalanceTransaction;
const refund = (id: string, amount: number, transaction: string | Stripe.BalanceTransaction | null, status = 'succeeded') => ({
  id, amount, balance_transaction: transaction, status, currency: 'usd', created: 1700000000,
}) as Stripe.Refund;

function fixture(receipts = [receipt(1, { material: '100.00' })]) {
  const rows = new Map<string, any>(), transactions = new Map<string, Stripe.BalanceTransaction | Error>();
  const estimate = { id: 7, materialProcessingCost: decimal(0), materialProcessingCostPending: false };
  const tx = {
    paymentReceipt: { findMany: jest.fn(async ({ where }) => receipts.filter(row => row.stripeChargeId === where.stripeChargeId)) },
    stripeProcessingCost: {
      findUnique: jest.fn(async ({ where }) => rows.get(where.stripeChargeId) ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = rows.has(where.stripeChargeId) ? { ...rows.get(where.stripeChargeId), ...update } : { ...create };
        rows.set(where.stripeChargeId, row); return row;
      }),
      findMany: jest.fn(async ({ where }) => [...rows.values()].filter(row => row.estimateId === where.estimateId)),
    },
    estimate: { update: jest.fn(async ({ data }) => Object.assign(estimate, data)) },
  };
  const stripe = { balanceTransactions: { retrieve: jest.fn(async (id: string) => {
    const transaction = transactions.get(id);
    if (transaction instanceof Error) throw transaction;
    if (!transaction) throw new Error('Unexpected simulated balance transaction request.');
    return transaction;
  }) } };
  const charge = { id: 'ch_test', amount_captured: receipts.reduce((total, item) => total + Number(item.amount.mul(100)), 0),
    currency: 'usd', balance_transaction: balance('txn_charge', 300) } as Stripe.Charge;
  return { receipts, rows, transactions, estimate, tx, stripe, charge,
    run: (refunds: Stripe.Refund[] = [], currentCharge = charge) => reconcileStripeProcessingCost(
      tx as unknown as Prisma.TransactionClient, stripe as unknown as Stripe, currentCharge, refunds,
    ),
    cost: () => rows.get(charge.id),
  };
}

describe('Stripe processing costs from immutable payment allocations', () => {
  it('records the real material fee once, even for repeated confirmations', async () => {
    const f = fixture(); f.charge.balance_transaction = 'txn_charge';
    f.transactions.set('txn_charge', balance('txn_charge', 287));
    await f.run(); await f.run();
    expect(f.rows.size).toBe(1);
    expect(f.cost()).toMatchObject({ status: 'CONFIRMED', currency: 'usd', balanceTransactionId: 'txn_charge' });
    expect(f.cost().fee.toFixed(2)).toBe('2.87');
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('2.87');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
    expect(f.stripe.balanceTransactions.retrieve).toHaveBeenCalledTimes(1);
  });

  it('allocates one charge fee across two receipts instead of charging the fee twice', async () => {
    const f = fixture([receipt(1, { material: '80.00' }), receipt(2, { installation: '20.00' })]);
    await f.run();
    expect(f.cost().fee.toFixed(2)).toBe('3.00');
    expect(f.cost().materialFee.toFixed(2)).toBe('2.40');
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('2.40');
    expect(f.rows.size).toBe(1);
  });

  it('compares frozen allocation values independently of persisted JSON object key order', async () => {
    const f = fixture(); const refunded = refund('re_partial', 1000, balance('txn_refund', 0));
    await f.run([refunded]);
    const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    f.cost().allocationSnapshot = reorder(f.cost().allocationSnapshot);
    await expect(f.run([refunded])).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(f.cost().fee.toFixed(2)).toBe('3.00'); expect(f.estimate.materialProcessingCostPending).toBe(false);
  });

  it('allocates exact cents across all five components, including a fee larger than capture', async () => {
    const f = fixture([receipt(1, { material: '0.01', installation: '0.01', permit: '0.01', city: '0.01', other: '0.01' })]);
    f.charge.balance_transaction = balance('txn_charge', 7);
    await f.run();
    expect(f.cost().materialFee.toFixed(2)).toBe('0.02');
    expect(f.cost().fee.toFixed(2)).toBe('0.07');
    expect(f.cost().status).toBe('CONFIRMED');
  });

  it('persists pending when no transaction is available and confirms when it arrives', async () => {
    const f = fixture(); f.charge.balance_transaction = null;
    await expect(f.run()).resolves.toMatchObject({ status: 'PENDING' });
    expect(f.cost().fee).toBeNull(); expect(f.estimate.materialProcessingCostPending).toBe(true);
    f.charge.balance_transaction = 'txn_later'; f.transactions.set('txn_later', balance('txn_later', 275));
    await f.run();
    expect(f.rows.size).toBe(1); expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('2.75');
    expect(f.estimate.materialProcessingCostPending).toBe(false); expect(f.cost().lastError).toBeNull();
  });

  it('does not fail payment confirmation or retain raw errors when Stripe cost lookup fails', async () => {
    const f = fixture(); f.charge.balance_transaction = 'txn_unavailable';
    f.transactions.set('txn_unavailable', new Error('Simulated request with sensitive provider details'));
    await expect(f.run()).resolves.toMatchObject({ status: 'PENDING' });
    expect(f.cost().lastError).toBe('Stripe processing cost is not available yet.');
    expect(JSON.stringify(f.cost())).not.toContain('sensitive provider');
  });

  it('limits unavailable cost lookups to five seconds without retries and persists pending', async () => {
    const f = fixture(); f.charge.balance_transaction = 'txn_unavailable';
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    f.stripe.balanceTransactions.retrieve.mockImplementation(async (...args: any[]) => {
      now += args[2].timeout;
      throw new Error('Simulated processor timeout');
    });
    try {
      await expect(f.run([1, 2, 3].map(id => refund(`re_${id}`, 1000, `txn_${id}`))))
        .resolves.toMatchObject({ status: 'PENDING' });
      expect(now).toBe(5000);
      const requests = f.stripe.balanceTransactions.retrieve.mock.calls as unknown as any[][];
      expect(requests.map(args => args[2])).toEqual([
        { timeout: 2000, maxNetworkRetries: 0 }, { timeout: 2000, maxNetworkRetries: 0 },
        { timeout: 1000, maxNetworkRetries: 0 },
      ]);
      expect(f.estimate.materialProcessingCostPending).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('requires review for an FX currency mismatch rather than inventing a conversion', async () => {
    const f = fixture(); f.charge.balance_transaction = balance('txn_eur', 300, 'eur');
    await expect(f.run()).resolves.toMatchObject({ status: 'REVIEW' });
    expect(f.cost().fee).toBeNull(); expect(f.estimate.materialProcessingCostPending).toBe(true);
  });

  it.each(['sum', 'currency', 'pending', 'missing'] as const)('requires review for %s allocation evidence', async reason => {
    const f = fixture([receipt(1, { material: '80.00' }), receipt(2, { installation: '20.00' })]);
    if (reason === 'sum') f.receipts[0].processingCostSnapshot.total = '79.00';
    if (reason === 'currency') f.receipts[0].currency = 'eur';
    if (reason === 'pending') f.receipts[0].processingCostSnapshot = {
      ...snapshot({ other: '80.00' }), allocationPending: true,
    };
    if (reason === 'missing') f.receipts[0].processingCostSnapshot = null;
    await expect(f.run()).resolves.toMatchObject({ status: 'REVIEW' });
    expect(f.stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(f.estimate.materialProcessingCostPending).toBe(true);
  });

  it('leaves historical receipts and estimate aggregates untouched without querying Stripe costs', async () => {
    const f = fixture(); f.receipts[0].processingCostSnapshot = null;
    await expect(f.run()).resolves.toEqual({ status: 'SKIPPED' });
    expect(f.stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(f.tx.stripeProcessingCost.findUnique).not.toHaveBeenCalled();
    expect(f.tx.stripeProcessingCost.upsert).not.toHaveBeenCalled();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });

  it('includes a new snapshotted payment on an existing estimate and aggregates other charges once', async () => {
    const f = fixture();
    f.rows.set('ch_previous', { stripeChargeId: 'ch_previous', estimateId: 7, status: 'CONFIRMED',
      materialFee: decimal('1.15'), materialSurcharge: decimal('0'), allocationSnapshot: { materialAffected: true } });
    await f.run(); await f.run();
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('4.15');
    expect(f.rows.size).toBe(2);
  });

  it('does not block material earnings for a pending installation-only charge', async () => {
    const f = fixture([receipt(1, { installation: '100.00' })]); f.charge.balance_transaction = null;
    await f.run();
    expect(f.cost().status).toBe('PENDING');
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('0.00');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
  });

  it('retains the original fee and adds only real signed refund adjustments idempotently', async () => {
    const f = fixture();
    const refunded = refund('re_partial', 5000, balance('txn_refund', -20));
    f.receipts[0].allocations.push({ refundId: refunded.id, amount: decimal(50), baseAmount: decimal(50) });
    await f.run([refunded]); await f.run([refunded, refunded]);
    expect(f.cost().allocationSnapshot.chargeFee).toBe('3.00');
    expect(f.cost().allocationSnapshot.refunds).toHaveLength(1);
    expect(f.cost().allocationSnapshot.refunds[0].fee).toBe('-0.20');
    expect(f.cost().fee.toFixed(2)).toBe('2.80');
    expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('2.80');
  });

  it('uses ledger allocations so an installation refund fee does not become a material cost', async () => {
    const f = fixture([receipt(1, { material: '80.00' }), receipt(2, { installation: '20.00' })]);
    const refunded = refund('re_installation', 2000, balance('txn_refund', 50));
    f.receipts[1].allocations.push({ refundId: refunded.id, amount: decimal(20), baseAmount: decimal(20) });
    await f.run([refunded]);
    expect(f.cost().fee.toFixed(2)).toBe('3.50');
    expect(f.cost().materialFee.toFixed(2)).toBe('2.40');
    expect(f.cost().allocationSnapshot.refunds[0].components.installation).toBe('20.00');
  });

  it('falls back to the frozen component proportions if a refund has no ledger allocations', async () => {
    const f = fixture([receipt(1, { material: '75.00', installation: '25.00' })]);
    await f.run([refund('re_partial', 4000, balance('txn_refund', 40))]);
    expect(f.cost().materialFee.toFixed(2)).toBe('2.55');
    expect(f.cost().allocationSnapshot.refunds[0].components).toMatchObject({ material: '30.00', installation: '10.00' });
  });

  it('keeps succeeded refunds pending until their actual cost is available', async () => {
    const f = fixture(); const refunded = refund('re_partial', 5000, null);
    await f.run([refunded]);
    expect(f.cost().allocationSnapshot.chargeFee).toBe('3.00');
    expect(f.cost().status).toBe('PENDING'); expect(f.estimate.materialProcessingCostPending).toBe(true);
    refunded.balance_transaction = 'txn_refund'; f.transactions.set('txn_refund', balance('txn_refund', -25));
    await f.run([refunded]);
    expect(f.cost().fee.toFixed(2)).toBe('2.75'); expect(f.cost().status).toBe('CONFIRMED');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
  });

  it('does not treat pending or failed refunds as completed processor adjustments', async () => {
    const f = fixture();
    await f.run([refund('re_pending', 5000, null, 'pending'), refund('re_failed', 3000, null, 'failed')]);
    expect(f.cost().fee.toFixed(2)).toBe('3.00'); expect(f.cost().status).toBe('CONFIRMED');
    expect(f.cost().allocationSnapshot.refunds).toEqual([]);
  });

  it.each([true, false])('preserves refund cents when an earlier pending refund succeeds later (fee known: %s)', async feeKnown => {
    const f = fixture([receipt(1, { material: '0.01', installation: '0.01' })]);
    f.charge.balance_transaction = balance('txn_charge', 2);
    const earlier = refund('re_earlier', 1, balance('txn_earlier', -1), 'pending');
    const later = refund('re_later', 1, feeKnown ? balance('txn_later', -1) : null);
    earlier.created = 1; later.created = 2;
    f.receipts[0].allocations.push(...[earlier, later].map(item => ({
      refundId: item.id, amount: decimal('0.01'), baseAmount: decimal('0.01'),
    })));
    await f.run([earlier, later]);
    expect(f.cost().allocationSnapshot.refunds[0]).toMatchObject({
      refundId: later.id, components: { material: '0.01', installation: '0.00' },
    });
    expect(f.cost().status).toBe(feeKnown ? 'CONFIRMED' : 'PENDING');

    earlier.status = 'succeeded'; later.balance_transaction = balance('txn_later', -1);
    await expect(f.run([earlier, later])).resolves.toMatchObject({ status: 'CONFIRMED' });
    await f.run([later, earlier]);
    expect(f.cost().allocationSnapshot.refunds.map((item: any) => item.refundId)).toEqual([later.id, earlier.id]);
    expect(f.cost().allocationSnapshot.refunds[1].components).toMatchObject({ material: '0.00', installation: '0.01' });
    expect(f.cost().fee.toFixed(2)).toBe('0.00'); expect(f.cost().materialFee.toFixed(2)).toBe('0.00');
    expect(f.estimate.materialProcessingCostPending).toBe(false);
  });

  it('subtracts only retained material surcharge and does not erase the fee after a full refund', async () => {
    const f = fixture([receipt(1, { material: '103.00' }, '3.00', '3.00')]);
    await f.run(); expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('0.00');
    const refunded = refund('re_full', 10300, balance('txn_refund', 0));
    f.receipts[0].allocations.push({ refundId: refunded.id, amount: decimal(103), baseAmount: decimal(100) });
    await f.run([refunded]);
    expect(f.cost().materialSurcharge.toFixed(2)).toBe('0.00');
    expect(f.cost().fee.toFixed(2)).toBe('3.00'); expect(f.estimate.materialProcessingCost.toFixed(2)).toBe('3.00');
  });

  it('rejects changed frozen allocations without moving an existing charge to another estimate', async () => {
    const f = fixture(); await f.run();
    f.receipts[0].payment.idEst = 9;
    await expect(f.run()).resolves.toMatchObject({ status: 'REVIEW' });
    expect(f.cost().estimateId).toBe(7); expect(f.cost().fee.toFixed(2)).toBe('3.00');
    expect(f.estimate.materialProcessingCostPending).toBe(true);
  });
});

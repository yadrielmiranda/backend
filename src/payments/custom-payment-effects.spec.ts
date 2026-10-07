import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { paymentIsCovered, remainingRefundBalance } from './payment-accounting';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';

const decimal = (value: string | number) => new Prisma.Decimal(value);

function fixture(sequence = 1) {
  const estimate: any = {
    id: 27, idUser: 9, number: '190027', units: 1, status: { name: 'Active' },
    dealerModeSnapshot: 'EXTERNAL', totalPayable: decimal('10641.27'),
    customerTotalPayable: decimal('10641.27'), installationJob: null, order: null,
    manualDiscount: null, promotionExpiresAt: null,
    paymentPlanSnapshot: { version: 1, name: '50/50', definition: {
      withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
        { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 }],
      withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
        { milestone: 'RELEASE', basis: 'PROJECT', percent: 50 }],
    } }, payments: [],
  };
  const payment: any = {
    id: 42, idEst: 27, type: 'INSTALLMENT', sequence, status: 'PAID', estimate,
    baseAmount: decimal(sequence === 1 ? '1000.00' : '2679.36'),
    netPaidBaseAmount: decimal(sequence === 1 ? '1000.00' : '2679.36'),
    originalBaseAmount: decimal(sequence === 1 ? '5320.64' : '5320.63'),
    refundCreditAmount: decimal(0), refundedAmount: decimal(0), refundReviewPending: false,
    paidAt: new Date('2026-10-07T12:00:00Z'), stripePaymentIntentId: null,
  };
  estimate.payments.push(payment);
  if (sequence === 2) {
    estimate.payments.push({ id: 41, idEst: 27, type: 'INSTALLMENT', sequence: 1,
      status: 'PAID', baseAmount: decimal('5320.64') });
    estimate.order = { id: 5, status: { name: 'Awaiting release' }, paymentId: 41 };
    estimate.status = { name: 'Ordered' };
  }
  const tx: any = {
    estimate: { findUnique: jest.fn(async () => estimate),
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)) },
    piece: { findMany: jest.fn(async () => []) },
    order: { findUnique: jest.fn(async () => estimate.order) },
  };
  const workflow: any = { markPaymentPaid: jest.fn(async () => false) };
  const notifications: any = { createAndSendToRoles: jest.fn(async () => []) };
  const service = new PaymentsService(tx, { get: () => 'sk_test_only_memory' } as any, workflow, notifications);
  const createOrder = jest.spyOn(service as any, 'ensureOrderForInitialPayment').mockResolvedValue(false);
  const advanceRelease = jest.spyOn(service as any, 'advanceAwaitingReleaseOrder').mockResolvedValue(false);
  return { estimate, payment, tx, workflow, notifications, createOrder, advanceRelease, service,
    confirm: () => (service as any).ensurePaidPaymentEffects(tx, payment) };
}

describe('Custom contributions keep installment requirements intact', () => {
  it('records the first partial contribution without creating an order or unlocking work', async () => {
    const f = fixture();
    await f.confirm();
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '1000.00', balance: '9641.27', canRelease: false });
    expect(f.createOrder).not.toHaveBeenCalled();
    expect(f.workflow.markPaymentPaid).not.toHaveBeenCalled();
    expect(f.advanceRelease).not.toHaveBeenCalled();
    expect(f.notifications.createAndSendToRoles.mock.calls[0][1].message).toContain('Remaining installment balance: $4320.64');
  });

  it('locks promotion terms after actual money is received without releasing the installment', async () => {
    const f = fixture(); f.estimate.promotionExpiresAt = new Date('2026-10-08T12:00:00Z');
    await f.confirm();
    expect(f.estimate.promotionLockedAt).toEqual(f.payment.paidAt);
    expect(f.createOrder).not.toHaveBeenCalled();
    expect(f.workflow.markPaymentPaid).not.toHaveBeenCalled();
  });

  it('applies $8000 as $5320.64 plus $2679.36 and keeps material release blocked', async () => {
    const f = fixture(2); await f.confirm();
    expect(buildPaymentSchedule(f.estimate)).toMatchObject({ paid: '8000.00', balance: '2641.27', canRelease: false,
      rows: [expect.objectContaining({ status: 'PAID', balance: '0.00' }),
        expect.objectContaining({ paid: '2679.36', balance: '2641.27' })] });
    expect(f.workflow.markPaymentPaid).not.toHaveBeenCalled();
    expect(f.advanceRelease).not.toHaveBeenCalled();
  });

  it('requires the last cent before invoking release effects', async () => {
    const f = fixture(2); f.payment.netPaidBaseAmount = decimal('5320.62');
    await f.confirm();
    expect(buildPaymentSchedule(f.estimate)?.canRelease).toBe(false);
    expect(f.advanceRelease).not.toHaveBeenCalled();
    f.payment.baseAmount = decimal('0.01'); f.payment.netPaidBaseAmount = decimal('5320.63');
    await f.confirm();
    expect(buildPaymentSchedule(f.estimate)?.canRelease).toBe(true);
    expect(f.workflow.markPaymentPaid).toHaveBeenCalledTimes(1);
    expect(f.advanceRelease).toHaveBeenCalledTimes(1);
  });
});

describe('Receipt-backed installment coverage', () => {
  const partial = { status: 'PAID', baseAmount: '2679.36', netPaidBaseAmount: '2679.36', originalBaseAmount: '5320.63' };
  it('does not interpret a successful partial capture as a fully covered charge', () => {
    expect(paymentIsCovered(partial)).toBe(false);
    expect(remainingRefundBalance(partial).toFixed(2)).toBe('2641.27');
  });
  it('uses accumulated receipts after a subsequent smaller payment', () => {
    expect(paymentIsCovered({ ...partial, baseAmount: '2641.27', netPaidBaseAmount: '5320.63' })).toBe(true);
  });
  it('reopens the balance for a refund and honors an approved reduction', () => {
    const refunded = { ...partial, netPaidBaseAmount: '5220.63', refundedAmount: '100.00' };
    expect(paymentIsCovered(refunded)).toBe(false);
    expect(paymentIsCovered({ ...refunded, refundCreditAmount: '100.00' })).toBe(true);
    expect(paymentIsCovered({ ...refunded, refundCreditAmount: '100.00', refundReviewPending: true })).toBe(false);
  });
  it('keeps historical completed payments and confirmed zero-dollar charges valid', () => {
    expect(paymentIsCovered({ status: 'PAID', baseAmount: '100.00' })).toBe(true);
    expect(paymentIsCovered({ status: 'PAID', baseAmount: '0.00', originalBaseAmount: '0.00', netPaidBaseAmount: '0.00' })).toBe(true);
    expect(paymentIsCovered({ status: 'PENDING', baseAmount: '0.00', originalBaseAmount: '0.00', netPaidBaseAmount: '0.00' })).toBe(false);
  });
});

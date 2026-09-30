import Decimal from 'decimal.js';
import { PaymentType } from '@prisma/client';
import { EstimatesService } from './estimates.service';
import { EstimatePieceCalculatorService } from './calculation/estimate-piece-calculator.service';
import { PaymentsService } from '@/payments/payments.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import {
  buildPaymentSchedule,
  installmentContext,
} from '@/payment-plans/payment-schedule';
import { withAgreementTransaction } from '@/contracts/agreement-content';
import { applyNetworkPricing } from '@/dealer-network/dealer-network';

const dealer: any = { id: 7, role: { name: 'dealer' } };
const plan = {
  version: 1,
  name: 'Half now',
  definition: {
    withoutInstallation: [
      { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
      { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
    ],
  },
};
const session = (status = 'open', payment_status = 'unpaid') => ({
  id: 'cs_1',
  status,
  payment_status,
  amount_total: 10000,
});

// Doble con rollback: los servicios y el calculador de totales son reales.
function fixture() {
  let estimate: any = {
    id: 1,
    number: '190001',
    idUser: 7,
    status: { id: 1, name: 'Active' },
    order: null,
    payments: [],
    pieces: [{ id: 2, qty: 1, mark: 'W1', dealerMarkup: '.2' }],
    materialRevisions: [],
    units: 1,
    totalPayable: '100',
    customerTotalPayable: '120',
    customerTaxRate: '.07',
    dealerModeSnapshot: 'INTERNAL',
    user: {
      id: 7,
      isTaxExempt: false,
      markupOverride: '.15',
      role: { name: 'dealer', markup: '.5' },
    },
  };
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: 1 }]),
    estimate: {
      findUnique: jest.fn(async () => estimate),
      findUniqueOrThrow: jest.fn(async () => estimate),
      findFirst: jest.fn(async () => estimate),
      update: jest.fn(async ({ data }) => {
        Object.assign(estimate, data);
        if (data.statusId === 5) estimate.status = { id: 5, name: 'Canceled' };
        if (data.status?.connect) estimate.status = { id: 1, name: 'Active' };
        return estimate;
      }),
    },
    estimateStatus: {
      findUnique: jest.fn(async ({ where }) => ({
        id: where.name === 'Canceled' ? 5 : 1,
        name: where.name,
      })),
    },
    payment: {
      findMany: jest.fn(async () => estimate.payments),
      updateMany: jest.fn(async ({ data }) => {
        estimate.payments.forEach((payment: any) =>
          Object.assign(payment, data),
        );
        return { count: estimate.payments.length };
      }),
    },
    user: { findUnique: jest.fn(async () => estimate.user) },
    globalParameter: {
      findUnique: jest.fn(async ({ where }) => ({
        value: where.key === 'SALES_TAX' ? '.08' : 30,
      })),
    },
    piece: { update: jest.fn() },
    pieceMuntin: { deleteMany: jest.fn() },
    estimateAgreement: { findMany: jest.fn(async () => []) },
  };
  tx.$transaction = jest.fn(async (work) => {
    const before = JSON.parse(JSON.stringify(estimate));
    try {
      return await work(tx);
    } catch (error) {
      estimate = before;
      throw error;
    }
  });
  const stripe = {
    checkout: {
      sessions: {
        retrieve: jest.fn(async () => session()),
        expire: jest.fn(async () => session('expired')),
      },
    },
  };
  const payments: any = Object.create(PaymentsService.prototype);
  Object.assign(payments, { prisma: tx, stripe });
  const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
  const calculate = jest
    .spyOn(calculator, 'calculatePieceMetrics')
    .mockImplementation(
      async (input, _markup, _tx, cache) =>
        applyNetworkPricing({
          ...input,
          rate: new Decimal(80),
          price: new Decimal(100),
          customerPrice: new Decimal(120),
          subtotal: new Decimal(100),
          customerSubtotal: new Decimal(120),
          markup: new Decimal('.15'),
          dealerMarkupDecimal: new Decimal('.2'),
          netProfit: new Decimal(20),
          netProfitD: new Decimal(20),
          dpPosPsf: new Decimal(0),
          dpNegPsf: new Decimal(0),
        } as any, cache?.networkSnapshot),
    );
  const logs = { log: jest.fn() };
  const workflow = {
    assertEstimateEditAllowed: jest.fn(),
    refreshUnpaidDealerMeasurements: jest.fn(),
    refreshAfterEstimateChange: jest.fn(),
  };
  const eligible = jest.fn(async () => []);
  const service = new EstimatesService(
    tx,
    logs as any,
    {} as any,
    {} as any,
    calculator,
    {} as any,
    workflow as any,
    {} as any,
    { eligible } as any,
    payments,
  );
  return {
    estimate: () => estimate,
    tx,
    stripe: stripe.checkout.sessions,
    payments,
    service,
    logs,
    workflow,
    calculate,
    eligible,
  };
}

describe('Estimate cancellation and reactivation', () => {
  it.each(['recalculate', 'reactivate'])('%s replaces old network tax with current terms while keeping customer tax', async action => {
    const f = fixture(), estimate = f.estimate();
    Object.assign(estimate.user, { username: 'subdealer', isActive: true, dealerMode: 'EXTERNAL',
      parentDealerId: 1, networkMarkup: '.2', networkTaxRate: '.0825', isTaxExempt: true });
    const root = { ...estimate.user, id: 1, username: 'root', parentDealerId: null, isTaxExempt: false };
    f.tx.user.findUnique.mockImplementation(async ({ where }: any) => where.id === 1 ? root : estimate.user);
    f.tx.user.findUniqueOrThrow = f.tx.user.findUnique;
    estimate.taxRate = '.01';
    if (action === 'reactivate') {
      estimate.status.name = 'Canceled';
      await f.service.reactivateEstimate(1, dealer);
    } else await f.service.recalculateEstimate(1, dealer);
    expect(f.estimate().taxRate.toString()).toBe('0.0825');
    expect(f.estimate().taxAmount.toString()).toBe('9.9');
    expect(f.estimate().totalPayable.toString()).toBe('129.9');
    expect(f.estimate().customerTaxRate.toString()).toBe('0.07');
    expect(f.estimate().dealerNetworkSnapshot.billingTaxRate).toBe('0.08');
    expect(f.estimate().dealerNetworkSnapshot.nodes[1].taxRate).toBe('0.0825');
  });

  it.each([
    dealer,
    { id: 90, role: { name: 'admin' } },
    { id: 91, role: { name: 'operator' } },
  ])(
    'allows an authorized actor and records the cancellation in the same transaction',
    async (actor) => {
      const f = fixture();
      f.estimate().payments = [
        { id: 1, status: 'PENDING', stripeSessionId: 'cs_1' },
      ];
      await f.service.cancelEstimate(1, actor);
      expect(f.estimate().status.name).toBe('Canceled');
      expect(f.stripe.expire).toHaveBeenCalledWith('cs_1');
      expect(f.estimate().payments[0]).toMatchObject({
        status: 'CANCELED',
        stripeSessionId: null,
      });
      expect(f.logs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: actor.id,
          after: { status: 'Canceled' },
        }),
        f.tx,
      );
      expect(f.tx.estimateAgreement.findMany).not.toHaveBeenCalled();
      await f.service.cancelEstimate(1, actor);
      expect(f.logs.log).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { id: 8, role: { name: 'dealer' } },
    { id: 7, role: { name: 'client' } },
  ])('rejects unauthorized actors', async (actor) => {
    const f = fixture();
    await expect(f.service.cancelEstimate(1, actor as any)).rejects.toThrow(
      'not found',
    );
    expect(f.stripe.retrieve).not.toHaveBeenCalled();
    expect(f.estimate().status.name).toBe('Active');
  });
  it('rejects an existing order and an unfinished material revision', async () => {
    const f = fixture();
    f.estimate().order = { id: 8 };
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow('order');
    f.estimate().order = null;
    f.estimate().materialRevisions = [{ id: 3 }];
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
      'pending material revision',
    );
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'PAID' },
    { status: 'REFUNDED' },
    { paidAt: '2026-09-01' },
    { receipts: [{ id: 1 }] },
    { netPaidBaseAmount: '1' },
    { netPaidBaseAmount: '0', refundedAmount: '100' },
    { refundReviewPending: true },
  ])(
    'preserves estimates with money or payment history: %j',
    async (payment) => {
      const f = fixture();
      f.estimate().payments = [{ status: 'CANCELED', ...payment }];
      await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
        'payment or refund history',
      );
      expect(f.estimate().status.name).toBe('Active');
      expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    session('complete'),
    session('complete', 'paid'),
    session('open', 'paid'),
    { ...session('complete', 'no_payment_required'), amount_total: 0 },
  ])('blocks a completed or processing checkout: %j', async (checkout) => {
    const f = fixture();
    f.estimate().payments = [{ status: 'PENDING', stripeSessionId: 'cs_1' }];
    f.stripe.retrieve.mockResolvedValue(checkout);
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
      'completed or is processing',
    );
    expect(f.estimate().status.name).toBe('Active');
    expect(f.stripe.expire).not.toHaveBeenCalled();
  });
  it('fails closed on a Stripe retrieval error and leaves the estimate active', async () => {
    const f = fixture();
    f.estimate().payments = [{ status: 'PENDING', stripeSessionId: 'cs_1' }];
    f.stripe.retrieve.mockRejectedValue(new Error('Stripe unavailable'));
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
      'Stripe unavailable',
    );
    expect(f.estimate().status.name).toBe('Active');
    expect(f.logs.log).not.toHaveBeenCalled();
  });
  it('does not cancel when the customer finishes checkout during expiration', async () => {
    const f = fixture();
    f.estimate().payments = [{ status: 'PENDING', stripeSessionId: 'cs_1' }];
    f.stripe.retrieve
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session('complete', 'paid'));
    f.stripe.expire.mockRejectedValue(new Error('Already complete'));
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
      'completed or is processing',
    );
    expect(f.estimate().status.name).toBe('Active');
    expect(f.estimate().payments[0].stripeSessionId).toBe('cs_1');
  });
  it('closes a shared checkout once and accepts a session that expired concurrently', async () => {
    const f = fixture();
    f.estimate().payments = [1, 2].map((id) => ({
      id,
      status: 'PENDING',
      stripeSessionId: 'cs_1',
    }));
    f.stripe.retrieve
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session('expired'));
    f.stripe.expire.mockRejectedValue(new Error('Already expired'));
    await f.service.cancelEstimate(1, dealer);
    expect(f.stripe.expire).toHaveBeenCalledTimes(1);
    expect(f.estimate().payments.every((p) => p.status === 'CANCELED')).toBe(
      true,
    );
  });
  it('rejects an unreconciled payment intent', async () => {
    const f = fixture();
    f.estimate().payments = [
      { status: 'PENDING', stripePaymentIntentId: 'pi_1' },
    ];
    await expect(f.service.cancelEstimate(1, dealer)).rejects.toThrow(
      'reconciliation',
    );
  });
  it('reactivates with current owner prices, taxes, promotions, expiry and installation in one transaction', async () => {
    const f = fixture();
    f.estimate().status.name = 'Canceled';
    f.estimate().paymentPlanSnapshot = {
      ...plan,
      locked: { at: 'old' },
      adjustments: [],
      legacyPaymentCredits: [],
    };
    f.estimate().payments = [{ status: 'CANCELED', stripeSessionId: null }];
    const start = Date.now();
    await f.service.reactivateEstimate(1, {
      id: 99,
      role: { name: 'admin' },
    } as any);
    expect(f.calculate.mock.calls[0][1].toString()).toBe('0.15');
    expect(f.eligible).toHaveBeenCalledWith(7, f.tx);
    expect(f.estimate().totalPayable.toString()).toBe('108');
    expect(f.estimate().customerTotalPayable.toString()).toBe('128.4');
    expect(f.estimate().expiresAt.getTime()).toBeGreaterThan(
      start + 29 * 86400000,
    );
    expect(f.estimate().paymentPlanSnapshot).toEqual(plan);
    expect(f.estimate().status.name).toBe('Active');
    expect(f.workflow.refreshAfterEstimateChange).toHaveBeenCalledWith(
      1,
      expect.anything(),
      f.tx,
    );
    expect(f.logs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { source: 'EstimatesService.reactivateEstimate' },
      }),
      f.tx,
    );
  });
  it('keeps canceled state if current pricing or installation cannot be recalculated', async () => {
    const f = fixture();
    f.estimate().status.name = 'Canceled';
    f.workflow.refreshAfterEstimateChange.mockRejectedValue(
      new Error('Installation price unavailable') as never,
    );
    await expect(f.service.reactivateEstimate(1, dealer)).rejects.toThrow(
      'Installation price unavailable',
    );
    expect(f.estimate().status.name).toBe('Canceled');
    expect(f.estimate().totalPayable).toBe('100');
  });
  it('does not reactivate an active estimate or one with unresolved payments', async () => {
    const f = fixture();
    await expect(f.service.reactivateEstimate(1, dealer)).rejects.toThrow(
      'Only canceled',
    );
    f.estimate().status.name = 'Canceled';
    f.estimate().payments = [{ status: 'PENDING' }];
    await expect(f.service.reactivateEstimate(1, dealer)).rejects.toThrow(
      'Reconcile',
    );
    expect(f.calculate).not.toHaveBeenCalled();
  });
  it('blocks ordinary edits and recalculation while canceled', async () => {
    const f = fixture();
    f.estimate().status.name = 'Canceled';
    const work = jest.fn();
    await expect(withAgreementTransaction(f.tx, 1, work)).rejects.toThrow(
      'canceled',
    );
    await expect(f.service.recalculateEstimate(1, dealer)).rejects.toThrow(
      'canceled',
    );
    expect(work).not.toHaveBeenCalled();
    expect(f.calculate).not.toHaveBeenCalled();
  });
  it('removes public and scheduled payment options while retaining historical amounts', async () => {
    const f = fixture();
    f.estimate().status.name = 'Canceled';
    f.estimate().paymentPlanSnapshot = plan;
    const schedule = buildPaymentSchedule(f.estimate())!;
    expect(schedule).toMatchObject({
      estimateCanceled: true,
      next: null,
      fullBalance: null,
      canRelease: false,
      canInstall: false,
    });
    expect(schedule.rows).toHaveLength(2);
    expect(await f.payments.getPublicPaymentContext('customer')).toEqual({
      enabled: true,
      status: 'canceled',
      payment: null,
    });
    expect(
      await f.payments.publicPaymentOptions(f.tx, f.estimate(), schedule),
    ).toMatchObject({ payments: [], fullBalance: null });
    await expect(installmentContext(f.tx, 1, 2, true, true)).rejects.toThrow(
      'canceled',
    );
  });
  it.each(Object.values(PaymentType))(
    'blocks preview, owner and manual checkout context for %s',
    async (type) => {
      const f = fixture();
      f.estimate().status.name = 'Canceled';
      const workflow: any = Object.create(
        InstallationWorkflowService.prototype,
      );
      for (const preview of [true, false])
        await expect(
          workflow.getPaymentContext(1, type, 1, true, dealer, f.tx, {
            preview,
          }),
        ).rejects.toThrow('canceled');
    },
  );
});

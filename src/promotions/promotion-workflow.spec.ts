import Decimal from 'decimal.js';
import { Prisma, PaymentStatus, PaymentType } from '@prisma/client';
import { EstimatesService } from '@/estimates/estimates.service';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { PaymentsService } from '@/payments/payments.service';
import { applyPromotion, PromotionTerms } from './promotion-pricing';
const actor = { id: 7, role: { name: 'client' as const } };
const offer: PromotionTerms = {
  id: 1,
  version: 2,
  name: 'Summer',
  percent: '20',
  brandId: 1,
  productId: null,
  systemId: null,
  startsAt: '2026-09-01T00:00:00Z',
  endsAt: '2026-09-15T12:00:00Z',
};
const D = (v: number | string) => new Prisma.Decimal(v);
function recalcFixture(promotions: PromotionTerms[] = [offer]) {
  const quote: any = {
    id: 1,
    idUser: 7,
    number: '190000',
    status: { name: 'Active' },
    order: null,
    ownerMarkupSnapshot: D('.2'),
    promotionExpiresAt: new Date('2026-09-02'),
    promotionLockedAt: null,
    customerTaxRate: D('.07'),
    user: { isTaxExempt: false },
    payments: [],
    pieces: [
      {
        id: 1,
        qty: 2,
        idBrand: 1,
        idProd: 2,
        idSyst: 3,
        idConf: 4,
        mark: 'A',
        dealerMarkup: D('.2'),
        pieceMuntin: null,
      },
    ],
  };
  const tx: any = {
    $queryRaw: jest.fn(),
    estimate: {
      findUnique: jest.fn().mockImplementation(async () => quote),
      update: jest.fn().mockImplementation(async ({ data }) => {
        Object.assign(quote, data);
        return quote;
      }),
    },
    estimateStatus: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    globalParameter: {
      findUnique: jest
        .fn()
        .mockImplementation(async ({ where }) => ({
          value: D(where.key === 'SALES_TAX' ? '.07' : 30),
        })),
    },
    piece: { update: jest.fn() },
    pieceMuntin: { deleteMany: jest.fn() },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 7, role: { name: 'client' } }),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn((fn) => fn(tx)) };
  const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
  jest
    .spyOn(calculator, 'calculatePieceMetrics')
    .mockImplementation(
      async (p, markup, db, cache) =>
        applyPromotion(
          {
            ...p,
            rate: new Decimal(80),
            price: new Decimal(100),
            customerPrice: new Decimal(120),
            subtotal: new Decimal(200),
            customerSubtotal: new Decimal(240),
            netProfit: new Decimal(20),
            netProfitD: new Decimal(40),
            markup: new Decimal('.2'),
            dealerMarkupDecimal: new Decimal('.2'),
            dpPosPsf: new Decimal(0),
            dpNegPsf: new Decimal(0),
            highBottom: false,
            highBottomPercent: null,
          },
          cache.promotions,
        ) as any,
    );
  const eligible = jest.fn().mockResolvedValue(promotions);
  const workflow = {
    assertEstimateEditAllowed: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EstimatesService(
    prisma,
    { log: jest.fn() } as any,
    {} as any,
    {} as any,
    calculator,
    {} as any,
    workflow as any,
    {} as any,
    { eligible } as any,
  );
  return { quote, tx, service, eligible, workflow };
}
describe('Promotion workflow integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());
  it('explicit recalculate replaces expired terms with eligible owner terms and net taxes', async () => {
    const f = recalcFixture();
    await f.service.recalculateEstimate(1, actor);
    expect(f.eligible).toHaveBeenCalledWith(7, f.tx);
    expect(f.quote.priceT.toString()).toBe('160');
    expect(f.quote.taxAmount.toString()).toBe('11.2');
    expect(f.quote.discountAmount.toString()).toBe('40');
    expect(f.quote.expiresAt.toISOString()).toBe(
      offer.endsAt.replace('Z', '.000Z'),
    );
    expect(
      f.tx.piece.update.mock.calls[0][0].data.promotionSnapshot.version,
    ).toBe(2);
  });
  it('recalculate removes expired discounts and restores normal expiry when no offer applies', async () => {
    const f = recalcFixture([]);
    await f.service.recalculateEstimate(1, actor);
    expect(f.quote.priceT.toString()).toBe('200');
    expect(f.quote.promotionExpiresAt).toBeNull();
    expect(f.quote.discountAmount.toString()).toBe('0');
    expect(f.quote.expiresAt).toEqual(f.quote.standardExpiresAt);
  });
  it('an existing material checkout still blocks recalculation', async () => {
    const f = recalcFixture();
    f.quote.payments = [
      {
        type: PaymentType.MATERIAL,
        status: PaymentStatus.PENDING,
        stripeSessionId: 'cs_open',
      },
    ];
    await expect(f.service.recalculateEstimate(1, actor)).rejects.toThrow(
      'already started',
    );
    expect(f.eligible).not.toHaveBeenCalled();
  });
  it('canceling unpaid checkout permits recalculation and removes an expired offer', async () => {
    const f = recalcFixture([]);
    f.quote.payments = [
      {
        type: PaymentType.MATERIAL,
        status: PaymentStatus.CANCELED,
        stripeSessionId: null,
      },
    ];
    await f.service.recalculateEstimate(1, actor);
    expect(f.quote.discountAmount.toString()).toBe('0');
  });
  it('a paid deposit locks terms even if the installation was later canceled', async () => {
    const f = recalcFixture();
    f.quote.promotionLockedAt = new Date();
    await expect(f.service.recalculateEstimate(1, actor)).rejects.toThrow(
      'Paid promotion terms',
    );
    expect(f.eligible).not.toHaveBeenCalled();
  });
  it('rejects expired promotional payments before creating a checkout', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      estimate: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 1,
            idUser: 7,
            promotionExpiresAt: new Date('2026-09-06'),
          }),
      },
    };
    const workflow = new InstallationWorkflowService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      workflow.getPaymentContext(1, PaymentType.MATERIAL, 1, false, actor, tx),
    ).rejects.toThrow('promotion has expired');
  });
  it('cancel payment expires the open Stripe link and clears its edit lock without preserving an offer', async () => {
    const payment = {
      id: 3,
      stripeSessionId: 'cs_open',
      status: PaymentStatus.PENDING,
    };
    const db: any = {
      estimate: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 1,
            idUser: 7,
            order: null,
            payments: [payment],
          }),
      },
      payment: { updateMany: jest.fn() },
    };
    const service: any = new PaymentsService(
      db,
      { get: () => 'sk_test_no_network' } as any,
      {} as any,
      {} as any,
    );
    service.stripe = {
      checkout: {
        sessions: {
          retrieve: jest
            .fn()
            .mockResolvedValue({ status: 'open', payment_status: 'unpaid' }),
          expire: jest.fn(),
        },
      },
    };
    expect(
      await service.cancelCheckoutSessionForEstimate({
        estimateId: 1,
        user: actor,
      }),
    ).toEqual({ status: 'canceled', orderId: null });
    expect(db.payment.updateMany.mock.calls[0][0].data).toEqual({
      status: 'CANCELED',
      stripeSessionId: null,
      stripePaymentIntentId: null,
    });
    expect(service.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      'cs_open',
    );
  });
  it('only accepts completed zero-dollar sessions as free orders', () => {
    const service: any = new PaymentsService(
      {} as any,
      { get: () => 'sk_test_no_network' } as any,
      {} as any,
      {} as any,
    );
    expect(
      service.isCompletedCheckout({
        status: 'complete',
        payment_status: 'no_payment_required',
        amount_total: 0,
      }),
    ).toBe(true);
    expect(
      service.isCompletedCheckout({
        status: 'open',
        payment_status: 'no_payment_required',
        amount_total: 0,
      }),
    ).toBe(false);
  });
});

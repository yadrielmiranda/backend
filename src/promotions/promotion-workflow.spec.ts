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
    user: {
      id: 7,
      isTaxExempt: false,
      markupOverride: null,
      role: { name: 'client', markup: D('.2') },
    },
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
        if (data.status?.connect) quote.status = { name: 'Active' };
        return quote;
      }),
    },
    estimateStatus: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    globalParameter: {
      findUnique: jest.fn().mockImplementation(async ({ where }) => ({
        value: D(where.key === 'SALES_TAX' ? '.07' : 30),
      })),
    },
    piece: { update: jest.fn() },
    pieceMuntin: { deleteMany: jest.fn() },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 7,
        markupOverride: null,
        role: { name: 'client', markup: D('.2') },
      }),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn((fn) => fn(tx)) };
  const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
  const calculate = jest
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
  return { quote, tx, service, eligible, workflow, calculate };
}
describe('Promotion workflow integration', () => {
  it('keeps the additional discount configuration while recalculating current promotions', async () => {
    const f = recalcFixture();
    const discount = { scope: 'MATERIAL', type: 'PERCENTAGE', value: '10' };
    f.quote.manualDiscount = discount;
    await f.service.recalculateEstimate(1, actor);
    expect(f.quote.manualDiscount).toEqual(discount);
    expect(f.quote.priceT.toString()).toBe('160');
    expect(f.tx.estimate.update.mock.calls[0][0].data).not.toHaveProperty('manualDiscount');
  });

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

  it.each([
    { override: '.15', roleMarkup: '.5', expected: '.15' },
    { override: null, roleMarkup: '.15', expected: '.15' },
    { override: '0', roleMarkup: '.5', expected: '0' },
    {
      override: '.150000000000000001',
      roleMarkup: '.5',
      expected: '.150000000000000001',
    },
  ])(
    'renews the saved markup with current owner terms: %j',
    async ({ override, roleMarkup, expected }) => {
      const f = recalcFixture();
      f.quote.ownerMarkupSnapshot = D('-.1668954');
      f.quote.user.markupOverride = override === null ? null : D(override);
      f.quote.user.role.markup = D(roleMarkup);
      await f.service.recalculateEstimate(1, actor);
      expect(f.calculate.mock.calls[0][1].eq(expected)).toBe(true);
      expect(f.quote.ownerMarkupSnapshot.eq(expected)).toBe(true);
      expect(
        f.tx.estimate.update.mock.calls[0][0].data.ownerMarkupSnapshot.eq(
          expected,
        ),
      ).toBe(true);
    },
  );

  it.each(['admin', 'operator'] as const)(
    'uses the owner markup when a different %s recalculates',
    async (role) => {
      const f = recalcFixture();
      f.quote.user.markupOverride = D('.15');
      f.tx.user.findUnique.mockResolvedValue({
        id: 99,
        markupOverride: D('.9'),
        role: { name: role, markup: D('.9') },
      });
      await f.service.recalculateEstimate(1, { id: 99, role: { name: role } });
      expect(f.calculate.mock.calls[0][1].eq('.15')).toBe(true);
      expect(f.quote.ownerMarkupSnapshot.eq('.15')).toBe(true);
      expect(f.eligible).toHaveBeenCalledWith(7, f.tx);
    },
  );

  it('brings an old negative-markup estimate to the same current prices as a new estimate', async () => {
    // Escenario controlado con los importes reportados: costo 118.74,
    // precio regular 136.55 y el mismo precio promocional del client: 99.74.
    const automatic: PromotionTerms = {
      ...offer,
      percent: '30',
      automaticDealerAdjustment: true,
      clientReferenceMarkup: '.2',
    };
    const old = recalcFixture([automatic]);
    const recent = recalcFixture([automatic]);
    old.quote.ownerMarkupSnapshot = D('-.1668954');
    recent.quote.ownerMarkupSnapshot = D('.15');
    for (const f of [old, recent]) {
      f.quote.pieces[0].qty = 1;
      f.quote.pieces[0].width = D(64);
      f.quote.pieces[0].height = D(42);
      f.quote.pieces[0].dealerMarkup = D(0);
      f.quote.user.markupOverride = D('.15');
      // El costo técnico es el mismo; el servicio debe suministrar el markup
      // actual a la calculadora y persistir los resultados en una transacción.
      f.calculate.mockImplementation(async (p, markup, db, cache) => {
        const rate = new Decimal('118.74');
        const price = rate
          .mul(markup.add(1))
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        return applyPromotion(
          {
            ...p,
            rate,
            price,
            markup,
            customerPrice: price,
            subtotal: price.mul(p.qty),
            customerSubtotal: price.mul(p.qty),
            netProfit: price.sub(rate),
            netProfitD: new Decimal(0),
            dealerMarkupDecimal: new Decimal(0),
            dpPosPsf: new Decimal(70),
            dpNegPsf: new Decimal(-80),
            highBottom: false,
            highBottomPercent: null,
          },
          cache.promotions,
        ) as any;
      });
      await f.service.recalculateEstimate(1, actor);
      const persisted = f.tx.piece.update.mock.calls[0][0].data;
      expect(persisted.rate.toString()).toBe('118.74');
      expect(persisted.markup.toString()).toBe('0.15');
      expect(persisted.regularPrice.toString()).toBe('136.55');
      expect(persisted.price.toString()).toBe('99.74');
      expect(persisted.promotionSnapshot.dealerPriceBasis).toEqual({
        regularPrice: '136.55',
        promotionalPrice: '99.74',
      });
      expect(f.quote.ownerMarkupSnapshot.toString()).toBe('0.15');
      expect(f.quote.priceT.toString()).toBe('99.74');
    }
    // Las siguientes piezas usan el nuevo snapshot sin volver al markup antiguo.
    const preview = await old.service.calculateAndReturnPieceMetrics(
      {
        idProd: 2,
        idBrand: 1,
        idSyst: 3,
        idConf: 4,
        idFC: 1,
        width: '64',
        height: '42',
        qty: 1,
      } as any,
      7,
      1,
    );
    expect(preview.price.toString()).toBe('99.74');
    expect(preview.regularPrice.toString()).toBe('136.55');
  });

  it.each([
    'order',
    'material payment',
    'installation deposit',
    'checkout',
    'foreign owner',
  ])(
    'does not replace historical markup or prices when blocked by %s',
    async (reason) => {
      const f = recalcFixture();
      f.quote.ownerMarkupSnapshot = D('-.1668954');
      f.quote.user.markupOverride = D('.15');
      if (reason === 'order') f.quote.order = { id: 1 };
      if (reason === 'material payment')
        f.quote.payments = [
          {
            type: PaymentType.MATERIAL,
            status: PaymentStatus.PAID,
            stripeSessionId: null,
          },
        ];
      if (reason === 'installation deposit')
        f.quote.promotionLockedAt = new Date();
      if (reason === 'checkout')
        f.quote.payments = [
          {
            type: PaymentType.MATERIAL,
            status: PaymentStatus.PENDING,
            stripeSessionId: 'cs_open',
          },
        ];
      if (reason === 'foreign owner') f.quote.idUser = 999;
      await expect(f.service.recalculateEstimate(1, actor)).rejects.toThrow();
      expect(f.quote.ownerMarkupSnapshot.toString()).toBe('-0.1668954');
      expect(f.calculate).not.toHaveBeenCalled();
      expect(f.tx.piece.update).not.toHaveBeenCalled();
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );

  it('recalculates automatic discounts, stores only applied terms and removes them when newly excluded', async () => {
    const automatic = {
      ...offer,
      percent: '50',
      automaticDealerAdjustment: true,
      clientReferenceMarkup: '1.161',
    };
    const f = recalcFixture([automatic]);
    await f.service.recalculateEstimate(1, actor);
    expect(f.quote.priceT.toString()).toBe('172.88');
    expect(f.quote.taxAmount.toString()).toBe('12.1');
    expect(f.quote.promotionContext[0].percent).toBe('13.56');
    expect(f.quote.promotionContext[0]).not.toHaveProperty(
      'clientReferenceMarkup',
    );
    f.eligible.mockResolvedValue([
      { ...automatic, version: 3, excludedSystemIds: [3] },
    ]);
    await f.service.recalculateEstimate(1, actor);
    expect(f.quote.priceT.toString()).toBe('200');
    expect(f.quote.promotionExpiresAt).toBeNull();
    expect(f.quote.promotionContext).toEqual([]);
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
        findUnique: jest.fn().mockResolvedValue({
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
        findUnique: jest.fn().mockResolvedValue({
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

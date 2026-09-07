import Decimal from 'decimal.js';
import { PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import { EstimatesService } from '@/estimates/estimates.service';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { applyPromotion, type PromotionTerms } from './promotion-pricing';

const offer: PromotionTerms = {
  id: 10,
  version: 1,
  name: 'Horizontal Rolling',
  percent: '20',
  brandId: 1,
  productId: 2,
  systemId: 3,
  startsAt: '2026-09-07T00:00:00Z',
  endsAt: '2026-09-13T23:19:00Z',
};
const D = (value: string | number) => new Prisma.Decimal(value);
const dto: any = {
  mark: 'New',
  idProd: 2,
  idBrand: 1,
  idSyst: 3,
  idConf: 4,
  idFC: 1,
  width: '65',
  height: '46',
  qty: 2,
  dealerMarkup: 50,
};

function fixture(
  active: PromotionTerms[] = [offer],
  actorId = 7,
  role = 'client',
) {
  const quote: any = {
    id: 16,
    idUser: 7,
    number: '190925',
    status: { name: 'Active' },
    order: null,
    ownerMarkupSnapshot: D('.2'),
    taxRate: D('.07'),
    customerTaxRate: D('.07'),
    standardExpiresAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2026-10-01T00:00:00Z'),
    promotionContext: [],
    promotionExpiresAt: null,
    promotionLockedAt: null,
    payments: [],
    pieces: [
      {
        ...dto,
        id: 41,
        idEst: 16,
        mark: 'Saved',
        qty: 1,
        rate: D(80),
        price: D(100),
        subtotal: D(100),
        regularPrice: D(100),
        customerPrice: D(150),
        customerSubtotal: D(150),
        regularCustomerPrice: D(150),
        promotionSnapshot: null,
        dealerMarkup: D('.5'),
        prod: { kind: 'GLAZED_UNIT' },
        pieceMuntin: null,
        heightLeft: null,
        heightRight: null,
        legHeight: null,
      },
    ],
  };
  const actor = {
    id: actorId,
    markupOverride: null,
    role: { name: role, markup: D('.2') },
  };
  const normalize = (data: any) => ({
    ...data,
    promotionSnapshot:
      data.promotionSnapshot === Prisma.DbNull ? null : data.promotionSnapshot,
  });
  const tx: any = {
    $queryRaw: jest.fn(),
    user: { findUnique: jest.fn().mockResolvedValue(actor) },
    estimate: {
      findUnique: jest.fn().mockImplementation(async () => quote),
      findUniqueOrThrow: jest.fn().mockImplementation(async () => quote),
      update: jest
        .fn()
        .mockImplementation(async ({ data }) => Object.assign(quote, data)),
    },
    piece: {
      findMany: jest.fn().mockImplementation(async () => quote.pieces),
      findFirst: jest
        .fn()
        .mockImplementation(
          async ({ where }) =>
            quote.pieces.find(
              (p: any) => p.id === where.id && p.idEst === where.idEst,
            ) ?? null,
        ),
      create: jest.fn().mockImplementation(async ({ data }) => {
        const p = {
          ...normalize(data),
          id: 42 + quote.pieces.length,
          prod: { kind: 'GLAZED_UNIT' },
          pieceMuntin: null,
        };
        quote.pieces.push(p);
        return { id: p.id };
      }),
      update: jest.fn().mockImplementation(async ({ where, data }) =>
        Object.assign(
          quote.pieces.find((p: any) => p.id === where.id),
          normalize(data),
        ),
      ),
    },
    pieceMuntin: { deleteMany: jest.fn() },
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
            customerPrice: new Decimal(150),
            subtotal: new Decimal(100).mul(p.qty),
            customerSubtotal: new Decimal(150).mul(p.qty),
            netProfit: new Decimal(20),
            netProfitD: new Decimal(50).mul(p.qty),
            markup: new Decimal('.2'),
            dealerMarkupDecimal: new Decimal('.5'),
            dpPosPsf: new Decimal(70),
            dpNegPsf: new Decimal(-80),
            highBottom: false,
            highBottomPercent: null,
            muntin: null,
          },
          cache.promotions,
        ) as any,
    );
  const eligible = jest.fn().mockResolvedValue(active);
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
  return { quote, tx, prisma, service, eligible, calculate, workflow };
}

describe('Current promotions for new estimate pieces', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('applies an offer introduced after estimate creation during both Calculate and Submit', async () => {
    const f = fixture();
    const saved = JSON.stringify(f.quote.pieces[0]);
    const preview = await f.service.calculateAndReturnPieceMetrics(dto, 7, 16);
    expect(preview.price.toString()).toBe('80');
    expect(preview.subtotal.toString()).toBe('160');
    expect(preview.regularPrice.toString()).toBe('100');
    expect(f.tx.piece.create).not.toHaveBeenCalled();
    expect(f.quote.promotionExpiresAt).toBeNull();
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.eligible).toHaveBeenNthCalledWith(1, 7);
    expect(f.eligible).toHaveBeenNthCalledWith(2, 7, f.tx);
    expect(f.quote.pieces[1].price.toString()).toBe('80');
    expect(f.quote.pieces[1].promotionSnapshot).toEqual(offer);
    expect(JSON.stringify(f.quote.pieces[0])).toBe(saved);
    expect(f.tx.piece.update).not.toHaveBeenCalled();
    expect(f.quote.priceT.toString()).toBe('260');
    expect(f.quote.discountAmount.toString()).toBe('40');
    expect(f.quote.taxAmount.toString()).toBe('18.2');
    expect(f.quote.expiresAt.toISOString()).toBe('2026-09-13T23:19:00.000Z');
  });

  it('uses the owner audience when an admin adds the piece', async () => {
    const f = fixture([offer], 99, 'admin');
    await f.service.calculateAndReturnPieceMetrics(dto, 99, 16);
    await f.service.addPieceToEstimate(16, dto, 99);
    expect(f.eligible).toHaveBeenNthCalledWith(1, 7);
    expect(f.eligible).toHaveBeenNthCalledWith(2, 7, f.tx);
  });

  it('does not use outdated estimate offers for a new piece when none are currently eligible', async () => {
    const f = fixture([]);
    f.quote.promotionContext = [offer];
    const preview = await f.service.calculateAndReturnPieceMetrics(dto, 7, 16);
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(preview.price.toString()).toBe('100');
    expect(f.quote.pieces[1].price.toString()).toBe('100');
    expect(f.quote.pieces[1].promotionSnapshot).toBeNull();
    expect(f.quote.discountAmount.toString()).toBe('0');
    expect(f.quote.expiresAt).toEqual(f.quote.standardExpiresAt);
  });

  it('keeps a new nonmatching piece at its regular price', async () => {
    const f = fixture();
    await f.service.addPieceToEstimate(16, { ...dto, idSyst: 9 }, 7);
    expect(f.quote.pieces[1].price.toString()).toBe('100');
    expect(f.quote.promotionExpiresAt).toBeNull();
  });

  it('chooses the largest matching current offer without stacking', async () => {
    const f = fixture([
      offer,
      { ...offer, id: 11, percent: '30' },
      { ...offer, id: 12, percent: '90', systemId: 8 },
    ]);
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.quote.pieces[1].price.toString()).toBe('70');
    expect(f.quote.pieces[1].promotionSnapshot.id).toBe(11);
  });

  it('supports a 100 percent current promotion without discounting other pieces', async () => {
    const f = fixture([{ ...offer, percent: '100' }]);
    const preview = await f.service.calculateAndReturnPieceMetrics(dto, 7, 16);
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(preview.price.toString()).toBe('0');
    expect(f.quote.pieces[1].subtotal.toString()).toBe('0');
    expect(f.quote.priceT.toString()).toBe('100');
    expect(f.quote.discountAmount.toString()).toBe('200');
  });

  it('reevaluates current availability at save rather than trusting a previous preview', async () => {
    const f = fixture();
    await f.service.calculateAndReturnPieceMetrics(dto, 7, 16);
    f.eligible.mockResolvedValue([]);
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.quote.pieces[1].price.toString()).toBe('100');
    expect(f.quote.pieces[1].promotionSnapshot).toBeNull();
  });

  it('keeps the earlier ordinary estimate expiry', async () => {
    const f = fixture();
    f.quote.expiresAt = f.quote.standardExpiresAt = new Date(
      '2026-09-10T00:00:00Z',
    );
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.quote.expiresAt.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('keeps the earliest promotion already applied to another piece', async () => {
    const f = fixture();
    const earlier = { ...offer, id: 2, endsAt: '2026-09-09T12:00:00Z' };
    f.quote.pieces[0].promotionSnapshot = earlier;
    f.quote.promotionExpiresAt = f.quote.expiresAt = new Date(earlier.endsAt);
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.quote.expiresAt.toISOString()).toBe('2026-09-09T12:00:00.000Z');
  });

  it('retains the new piece promotion when it is later edited, without applying it to old pieces', async () => {
    const f = fixture();
    await f.service.addPieceToEstimate(16, dto, 7);
    f.eligible.mockResolvedValue([{ ...offer, version: 2, percent: '40' }]);
    const id = f.quote.pieces[1].id;
    const preview = await f.service.calculateAndReturnPieceMetrics(
      dto,
      7,
      16,
      id,
    );
    expect(preview.price.toString()).toBe('80');
    await f.service.updatePieceInEstimate(16, id, dto, 7);
    expect(f.quote.pieces[1].price.toString()).toBe('80');
    const savedPreview = await f.service.calculateAndReturnPieceMetrics(
      dto,
      7,
      16,
      41,
    );
    expect(savedPreview.price.toString()).toBe('100');
    expect(f.eligible).toHaveBeenCalledTimes(1);
  });

  it.each(['markup', 'color'])(
    'preserves each piece promotion during a %s update',
    async (action) => {
      const f = fixture();
      f.quote.pieces[0].promotionSnapshot = {
        ...offer,
        version: 0,
        percent: '10',
      };
      await f.service.addPieceToEstimate(16, dto, 7);
      if (action === 'markup')
        await f.service.applyGeneralDealerMarkupToEstimate(16, 50, 7);
      else
        await f.service.applyBulkPieceAttributeToEstimate(16, { idFC: 2 }, 7);
      expect(f.quote.pieces[0].price.toString()).toBe('90');
      expect(f.quote.pieces[1].price.toString()).toBe('80');
      expect(f.eligible).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a saved piece from another estimate and requires estimateId with pieceId', async () => {
    const f = fixture();
    await expect(
      f.service.calculateAndReturnPieceMetrics(dto, 7, 16, 900),
    ).rejects.toThrow('was not found');
    await expect(
      f.service.calculateAndReturnPieceMetrics(dto, 7, undefined, 41),
    ).rejects.toThrow('requires an estimateId');
    expect(f.eligible).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized owner before finding current promotions', async () => {
    const f = fixture([offer], 8);
    await expect(
      f.service.calculateAndReturnPieceMetrics(dto, 8, 16),
    ).rejects.toThrow('not found/denied');
    await expect(f.service.addPieceToEstimate(16, dto, 8)).rejects.toThrow(
      'not found/denied',
    );
    expect(f.eligible).not.toHaveBeenCalled();
  });

  it.each(['expired', 'locked', 'order', 'checkout', 'paid', 'inactive'])(
    'keeps the %s edit restriction on preview and save',
    async (state) => {
      const f = fixture();
      if (state === 'expired')
        f.quote.promotionExpiresAt = new Date('2026-09-06');
      if (state === 'locked') f.quote.promotionLockedAt = new Date();
      if (state === 'order') f.quote.order = { id: 1 };
      if (state === 'inactive') f.quote.status.name = 'Expired';
      if (state === 'checkout' || state === 'paid')
        f.quote.payments = [
          {
            type: PaymentType.MATERIAL,
            status:
              state === 'paid' ? PaymentStatus.PAID : PaymentStatus.PENDING,
            stripeSessionId: state === 'checkout' ? 'cs_open' : null,
          },
        ];
      await expect(
        f.service.calculateAndReturnPieceMetrics(dto, 7, 16),
      ).rejects.toThrow();
      await expect(f.service.addPieceToEstimate(16, dto, 7)).rejects.toThrow();
      expect(f.eligible).not.toHaveBeenCalled();
      expect(f.tx.piece.create).not.toHaveBeenCalled();
    },
  );

  it('allows current promotions again after an unpaid checkout is canceled', async () => {
    const f = fixture();
    f.quote.payments = [
      {
        type: PaymentType.MATERIAL,
        status: PaymentStatus.CANCELED,
        stripeSessionId: null,
      },
    ];
    await f.service.addPieceToEstimate(16, dto, 7);
    expect(f.quote.pieces[1].price.toString()).toBe('80');
  });
});

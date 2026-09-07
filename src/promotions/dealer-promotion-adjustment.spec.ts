import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { validateSync } from 'class-validator';
import { PromotionsService } from './promotions.service';
import { PromotionDto } from './promotions.dto';
import {
  applyPromotion,
  promotionDeadline,
  savedPromotions,
  type PromotionTerms,
} from './promotion-pricing';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';

const offer = (fields: Partial<PromotionTerms> = {}): PromotionTerms => ({
  id: 1,
  version: 1,
  name: 'Client offer',
  percent: '50',
  brandId: null,
  productId: null,
  systemId: null,
  startsAt: '2026-09-01T00:00:00Z',
  endsAt: '2026-09-30T23:00:00Z',
  automaticDealerAdjustment: true,
  clientReferenceMarkup: '1',
  ...fields,
});
const piece = (price = '100', rate = '86.44') => ({
  idBrand: 10,
  idProd: 20,
  idSyst: 30,
  qty: 2,
  price: new Decimal(price),
  rate: new Decimal(rate),
  customerPrice: new Decimal(price).mul('1.5'),
  subtotal: new Decimal(price).mul(2),
  customerSubtotal: new Decimal(price).mul(3),
  netProfit: new Decimal(price).sub(rate),
  netProfitD: new Decimal(price),
  markup: new Decimal('.2'),
});

describe('Automatic dealer discounts', () => {
  it('matches the client price exactly without rounding the discount to a whole percent', () => {
    const p = piece(),
      promotion = offer();
    const result = applyPromotion(p, [promotion]);
    expect(result.price.toString()).toBe('86.44');
    expect(result.subtotal.toString()).toBe('172.88');
    expect(result.promotionSnapshot?.percent).toBe('13.56');
    expect(result.promotionSnapshot?.dealerPriceBasis).toEqual({
      regularPrice: '100',
      promotionalPrice: '86.44',
    });
    expect(result.promotionSnapshot?.automaticDealerAdjustment).toBe(true);
    expect(result.promotionSnapshot).not.toHaveProperty(
      'clientReferenceMarkup',
    );
    expect(result.regularPrice.toString()).toBe('100');
    expect(result.markup).toBe(p.markup);
    expect(promotion.percent).toBe('50');
    expect(promotion.clientReferenceMarkup).toBe('1');
  });

  it.each(['90', '100', '120'])(
    'brings dealer price %s to the same client promotional price',
    (regular) => {
      const result = applyPromotion(piece(regular), [offer()]);
      expect(result.price.toString()).toBe('86.44');
      expect(result.promotionSnapshot?.dealerPriceBasis).toEqual({
        regularPrice: regular,
        promotionalPrice: '86.44',
      });
    },
  );

  it.each(['0', '80', '86.44'])(
    'keeps price %s when already lower or equal',
    (regular) => {
      const p = piece(regular);
      const result = applyPromotion(p, [offer()]);
      expect(result.price).toBe(p.price);
      expect(result.promotionSnapshot).toBeNull();
      expect(promotionDeadline([result])).toBeNull();
    },
  );

  it('applies a one-cent saving even when the discount is less than one percent', () => {
    const result = applyPromotion(piece('86.45'), [offer()]);
    expect(result.price.toString()).toBe('86.44');
    expect(result.subtotal.toString()).toBe('172.88');
    expect(result.promotionSnapshot).not.toBeNull();
    expect(promotionDeadline([result])).not.toBeNull();
  });

  it('uses the unrounded technical amount to reproduce client pricing', () => {
    const result = applyPromotion(
      piece('2', '.03'),
      [offer({ clientReferenceMarkup: '99' })],
      new Decimal('.034'),
    );
    expect(result.price.toString()).toBe('1.7');
    expect(result.promotionSnapshot?.percent).toBe('15');
  });

  it('rounds the client regular and promotional unit prices before deriving the percentage', () => {
    const result = applyPromotion(piece('100', '77.777'), [
      offer({ clientReferenceMarkup: '.7', percent: '35' }),
    ]);
    // Client: 132.22 -> 85.94. El dealer paga también 85.94.
    expect(result.promotionSnapshot?.percent).toBe('14.06');
    expect(result.price.toString()).toBe('85.94');
  });

  it('uses the largest automatic discount among matching client promotions', () => {
    const result = applyPromotion(piece(), [
      offer({ percent: '40' }),
      offer({ id: 2 }),
      offer({ id: 3, percent: '99', systemId: 999 }),
    ]);
    expect(result.promotionSnapshot?.id).toBe(2);
    expect(result.price.toString()).toBe('86.44');
  });

  it('keeps direct dealer percentages exact and ahead of automatic adjustments', () => {
    const direct = offer({
      id: 2,
      automaticDealerAdjustment: undefined,
      clientReferenceMarkup: undefined,
      percent: '5.5',
    });
    const result = applyPromotion(piece(), [offer({ percent: '90' }), direct]);
    expect(result.price.toString()).toBe('94.5');
    expect(result.promotionSnapshot?.percent).toBe('5.5');
  });

  it('supports free material and does not enforce a cost floor', () => {
    expect(
      applyPromotion(piece(), [offer({ percent: '100' })]).price.toString(),
    ).toBe('0');
    const result = applyPromotion(piece(), [offer({ percent: '90' })]);
    expect(result.price.lt(result.rate)).toBe(true);
  });

  it('retains exact saved automatic terms without consulting current reference markups', () => {
    const first = applyPromotion(piece(), [offer()]);
    const saved = savedPromotions(
      {
        promotionLockedAt: new Date(),
        promotionContext: [first.promotionSnapshot],
      },
      Date.parse('2027-01-01'),
    );
    expect(applyPromotion(piece(), saved).price.toString()).toBe('86.44');
    expect(promotionDeadline([first])?.toISOString()).toBe(
      '2026-09-30T23:00:00.000Z',
    );
  });

  it('preserves exact customer rounding after saving a repeating discount ratio', () => {
    const p = { ...piece('6', '5'), customerPrice: new Decimal('7.23') };
    const result = applyPromotion(p, [offer()]);
    expect(result.price.toString()).toBe('5');
    expect(result.customerPrice.toString()).toBe('6.03');
    expect(result.customerSubtotal.toString()).toBe('12.06');
    const saved = JSON.parse(JSON.stringify(result.promotionSnapshot));
    const reopened = applyPromotion(p, [saved]);
    expect(reopened.price.toString()).toBe('5');
    expect(reopened.customerPrice.toString()).toBe('6.03');
    const resized = applyPromotion(
      {
        ...p,
        price: new Decimal(12),
        customerPrice: new Decimal('14.46'),
      },
      [saved],
    );
    expect(resized.price.toString()).toBe('10');
    expect(resized.customerPrice.toString()).toBe('12.05');
  });

  it('multiplies the exact unit price by quantity without accumulating percentage rounding', () => {
    const result = applyPromotion({ ...piece('100.01', '100'), qty: 137 }, [
      offer(),
    ]);
    expect(result.price.toString()).toBe('100');
    expect(result.subtotal.toString()).toBe('13700');
  });

  it('preserves previously saved whole-percent terms until an explicit recalculation', () => {
    const legacy = offer({ percent: '13', clientReferenceMarkup: undefined });
    expect(applyPromotion(piece(), [legacy]).price.toString()).toBe('87');
    expect(applyPromotion(piece(), [offer()]).price.toString()).toBe('86.44');
  });
});

describe('Product and system exclusions', () => {
  it.each([
    { excludedProductIds: [20] },
    { excludedSystemIds: [30] },
    { excludedProductIds: [20], excludedSystemIds: [30] },
  ])(
    'excludes matching material from direct and automatic offers: %j',
    (exclusions) => {
      for (const automatic of [true, false]) {
        const p = piece();
        const result = applyPromotion(p, [
          offer({
            ...exclusions,
            automaticDealerAdjustment: automatic,
            clientReferenceMarkup: automatic ? '1' : undefined,
          }),
        ]);
        expect(result.price).toBe(p.price);
        expect(result.promotionSnapshot).toBeNull();
      }
    },
  );

  it('excludes every system of an excluded product, only the listed system otherwise', () => {
    expect(
      applyPromotion({ ...piece(), idSyst: 31 }, [
        offer({ excludedProductIds: [20] }),
      ]).promotionSnapshot,
    ).toBeNull();
    expect(
      applyPromotion({ ...piece(), idSyst: 31 }, [
        offer({ excludedSystemIds: [30] }),
      ]).price.toString(),
    ).toBe('86.44');
  });

  it('can apply another promotion when this one excludes the product', () => {
    const result = applyPromotion(piece(), [
      offer({ id: 2, percent: '90', excludedProductIds: [20] }),
      offer(),
    ]);
    expect(result.promotionSnapshot?.id).toBe(1);
  });

  it('preserves historical snapshots that predate exclusions', () => {
    const old = offer({
      automaticDealerAdjustment: undefined,
      clientReferenceMarkup: undefined,
      percent: '20',
    });
    expect(applyPromotion(piece(), [old]).price.toString()).toBe('80');
  });
});

function audienceFixture() {
  const client = { id: 101, idRole: 71, role: { name: 'client' } };
  const dealer = { id: 202, idRole: 82, role: { name: 'dealer' } };
  const users = [
    client,
    dealer,
    { id: 303, idRole: 93, role: { name: 'operator' } },
  ];
  const promotion: any = {
    ...offer(),
    automaticDealerAdjustment: undefined,
    clientReferenceMarkup: undefined,
    audience: 'ROLE',
    roleIds: [71],
    userIds: [],
    percent: new Prisma.Decimal(50),
    startsAt: new Date('2026-09-01'),
    endsAt: new Date('2026-09-30'),
    excludedProductIds: [],
    excludedSystemIds: [],
  };
  const tx: any = {
    user: {
      findUniqueOrThrow: jest.fn(async ({ where }) =>
        users.find((u) => u.id === where.id),
      ),
      findMany: jest.fn().mockResolvedValue([
        { id: 101, idRole: 71, markupOverride: null },
        { id: 102, idRole: 71, markupOverride: new Prisma.Decimal('.25') },
      ]),
    },
    role: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 71, markup: new Prisma.Decimal('.5') }),
    },
    promotion: {
      findMany: jest.fn().mockImplementation(async () => [promotion]),
    },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    product: {
      findMany: jest.fn().mockResolvedValue([{ id: 20, name: 'Single Hung' }]),
    },
    system: {
      findMany: jest.fn().mockResolvedValue([{ id: 30, name: 'Series A' }]),
    },
    estimate: {
      findUnique: jest.fn().mockResolvedValue({
        idUser: 202,
        ownerMarkupSnapshot: new Prisma.Decimal(0),
        pieces: [],
      }),
    },
  };
  return { promotion, tx, service: new PromotionsService(tx) };
}

describe('Automatic promotion audiences', () => {
  it('uses database role identifiers, keeps client discounts direct and operator ineligible', async () => {
    const f = audienceFixture();
    const clients = await f.service.eligible(101);
    expect(clients[0].percent).toBe('50');
    expect(clients[0].automaticDealerAdjustment).toBeUndefined();
    expect(await f.service.eligible(303)).toEqual([]);
    const dealers = await f.service.eligible(202);
    expect(dealers[0].automaticDealerAdjustment).toBe(true);
    expect(dealers[0].clientReferenceMarkup).toBe('0.5');
    expect(f.tx.role.findUnique).toHaveBeenCalledWith({
      where: { name: 'client' },
      select: { id: true, markup: true },
    });
  });

  it.each(['ROLE', 'ALL', 'USERS'])(
    'keeps explicit dealer audience %s direct',
    async (audience) => {
      const f = audienceFixture();
      Object.assign(f.promotion, {
        audience,
        roleIds: [71, 82],
        userIds: [202],
      });
      const result = await f.service.eligible(202);
      expect(result[0].percent).toBe('50');
      expect(result[0].automaticDealerAdjustment).toBeUndefined();
    },
  );

  it('uses the lowest effective markup for a promotion exclusively assigned to selected clients', async () => {
    const f = audienceFixture();
    Object.assign(f.promotion, { audience: 'USERS', userIds: [101, 102] });
    expect((await f.service.eligible(202))[0].clientReferenceMarkup).toBe(
      '0.25',
    );
  });

  it('does not broaden a private promotion assigned to another dealer or a mixed audience', async () => {
    const f = audienceFixture();
    Object.assign(f.promotion, { audience: 'USERS', userIds: [101, 404] });
    f.tx.user.findMany.mockResolvedValue([
      { id: 101, idRole: 71 },
      { id: 404, idRole: 82 },
    ]);
    expect(await f.service.eligible(202)).toEqual([]);
    f.promotion.userIds = [404];
    expect(await f.service.eligible(202)).toEqual([]);
  });

  it('does not infer automatic eligibility from an empty, stale or unrelated audience', async () => {
    const f = audienceFixture();
    f.promotion.roleIds = [];
    expect(await f.service.eligible(202)).toEqual([]);
    f.promotion.roleIds = [93];
    expect(await f.service.eligible(202)).toEqual([]);
    Object.assign(f.promotion, { audience: 'USERS', userIds: [999] });
    expect(await f.service.eligible(202)).toEqual([]);
  });

  it('does not advertise the client percentage or expose reference markup to the dealer', async () => {
    const f = audienceFixture();
    Object.assign(f.promotion, {
      excludedProductIds: [20],
      excludedSystemIds: [30],
    });
    const available = await f.service.available(
      { id: 999, role: { name: 'admin' } },
      16,
    );
    expect(available.promotions[0].percent).toBeNull();
    expect(available.promotions[0]).not.toHaveProperty('clientReferenceMarkup');
    expect(available.promotions[0].excludedProductNames).toEqual([
      'Single Hung',
    ]);
    expect(available.promotions[0].excludedSystemNames).toEqual(['Series A']);
  });
});

describe('Saving exclusions', () => {
  const valid: PromotionDto = {
    name: 'Offer',
    percent: 20,
    audience: 'ALL',
    enabled: true,
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: '2026-09-30T00:00:00Z',
    excludedProductIds: [20, 21],
    excludedSystemIds: [30, 31],
  };
  const fixture = () => {
    const tx: any = {
      product: { count: jest.fn().mockResolvedValue(2) },
      system: { count: jest.fn().mockResolvedValue(2) },
      promotion: {
        findUnique: jest.fn().mockResolvedValue({ id: 1 }),
        create: jest.fn(async ({ data }) => data),
        update: jest.fn(async ({ data }) => data),
      },
    };
    return {
      tx,
      service: new PromotionsService({ $transaction: (fn) => fn(tx) } as any),
    };
  };
  it('saves both exclusion lists and can later remove them', async () => {
    const f = fixture();
    expect(await f.service.save(valid)).toEqual(
      expect.objectContaining({
        excludedProductIds: [20, 21],
        excludedSystemIds: [30, 31],
      }),
    );
    const saved = await f.service.save(
      { ...valid, excludedProductIds: [], excludedSystemIds: [] },
      1,
    );
    expect(saved.excludedProductIds).toEqual([]);
    expect(saved.excludedSystemIds).toEqual([]);
  });
  it.each(['product', 'system'])(
    'rejects nonexistent excluded %s IDs',
    async (entity) => {
      const f = fixture();
      f.tx[entity].count.mockResolvedValue(1);
      await expect(f.service.save(valid)).rejects.toThrow(
        `Select valid excluded ${entity}s`,
      );
      expect(f.tx.promotion.create).not.toHaveBeenCalled();
    },
  );
  it.each(['excludedProductIds', 'excludedSystemIds'])(
    'validates %s as a list of unique positive integer IDs',
    (key) => {
      for (const value of [[0], [-1], [1.5], ['20'], [20, 20], '20']) {
        const errors = validateSync(
          Object.assign(new PromotionDto(), valid, { [key]: value }),
        );
        expect(errors.some((e) => e.property === key)).toBe(true);
      }
      expect(validateSync(Object.assign(new PromotionDto(), valid))).toEqual(
        [],
      );
    },
  );
});

describe('Paid installation revisions', () => {
  it('retains each piece percentage when the same promotion produced different dealer discounts', async () => {
    const service: any = new InstallationWorkflowService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    service.pieceCalculator = { createCalculationCache: () => ({}) };
    const tx: any = {
      estimate: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          promotionLockedAt: new Date(),
          promotionContext: [
            offer({ percent: '25', clientReferenceMarkup: undefined }),
          ],
        }),
      },
    };
    const cache = await service.promotionRevisionCache(1, tx, {
      promotionSnapshot: offer({
        percent: '13',
        clientReferenceMarkup: undefined,
      }),
    });
    expect(applyPromotion(piece(), cache.promotions).price.toString()).toBe(
      '87',
    );
    const withoutPromotion = await service.promotionRevisionCache(1, tx, {
      promotionSnapshot: null,
    });
    expect(
      applyPromotion(piece(), withoutPromotion.promotions).price.toString(),
    ).toBe('100');
  });
});

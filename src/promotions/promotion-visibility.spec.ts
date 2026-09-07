import { Prisma } from '@prisma/client';
import { PromotionsService } from './promotions.service';

function fixture({
  dealerMarkup = '.2',
  clientMarkup = '.5',
  percent = 20,
} = {}) {
  const user = {
    id: 202,
    idRole: 82,
    markupOverride: null as Prisma.Decimal | null,
    role: { name: 'dealer', markup: new Prisma.Decimal(dealerMarkup) },
  };
  const promotion = {
    id: 1,
    version: 1,
    name: 'Client promotion',
    percent: new Prisma.Decimal(percent),
    audience: 'ROLE',
    roleIds: [71],
    userIds: [] as number[],
    brandId: null,
    productId: null,
    systemId: null,
    excludedProductIds: [],
    excludedSystemIds: [],
    startsAt: new Date('2026-09-01'),
    endsAt: new Date('2026-09-30'),
  };
  const estimate = {
    idUser: user.id,
    ownerMarkupSnapshot: new Prisma.Decimal(dealerMarkup),
    pieces: [] as Array<{
      regularPrice: Prisma.Decimal;
      price: Prisma.Decimal;
      promotionSnapshot: object | null;
    }>,
  };
  const db = {
    user: {
      findUniqueOrThrow: jest.fn(async () => user),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 101, idRole: 71, markupOverride: new Prisma.Decimal('.3') },
        ]),
    },
    role: {
      findUnique: jest.fn().mockResolvedValue({
        id: 71,
        markup: new Prisma.Decimal(clientMarkup),
      }),
    },
    promotion: { findMany: jest.fn(async () => [promotion]) },
    estimate: { findUnique: jest.fn(async () => estimate) },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    system: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    user,
    promotion,
    estimate,
    db,
    service: new PromotionsService(db as any),
    actor: { id: user.id, role: { name: 'dealer' } },
  };
}

describe('Dealer promotion banner visibility', () => {
  it.each(['.1', '.2'])(
    'hides automatic offers at dealer markup %s when already cheaper or equal',
    async (dealerMarkup) => {
      // Client regular factor 1.5, less 20% = 1.2.
      const f = fixture({ dealerMarkup });
      expect((await f.service.available(f.actor)).promotions).toEqual([]);
      expect((await f.service.available(f.actor, 16)).promotions).toEqual([]);
      // Visibility must not remove eligibility from the price calculator.
      expect(await f.service.eligible(f.actor.id)).toHaveLength(1);
    },
  );

  it.each(['.21', '.3'])(
    'shows an automatic offer at markup %s even when saving less than one percent',
    async (dealerMarkup) => {
      const f = fixture({ dealerMarkup });
      for (const estimateId of [undefined, 16]) {
        const offers = (await f.service.available(f.actor, estimateId))
          .promotions;
        expect(offers).toHaveLength(1);
        expect(offers[0].automaticDealerAdjustment).toBe(true);
        expect(offers[0].percent).toBeNull();
        expect(offers[0]).not.toHaveProperty('clientReferenceMarkup');
      }
    },
  );

  it('uses a zero markup override instead of falling back to the dealer role markup', async () => {
    const f = fixture({ dealerMarkup: '.5' });
    f.user.markupOverride = new Prisma.Decimal(0);
    expect((await f.service.available(f.actor)).promotions).toEqual([]);
  });

  it('uses the estimate markup instead of the current account markup, also for administrators', async () => {
    const f = fixture({ dealerMarkup: '.1' });
    f.estimate.ownerMarkupSnapshot = new Prisma.Decimal('.4');
    expect((await f.service.available(f.actor)).promotions).toEqual([]);
    expect((await f.service.available(f.actor, 16)).promotions).toHaveLength(1);
    expect(
      (await f.service.available({ id: 999, role: { name: 'admin' } }, 16))
        .promotions,
    ).toHaveLength(1);
    expect(f.db.user.findUniqueOrThrow).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 202 } }),
    );

    f.user.role.markup = new Prisma.Decimal('.4');
    f.estimate.ownerMarkupSnapshot = new Prisma.Decimal('.1');
    expect((await f.service.available(f.actor)).promotions).toHaveLength(1);
    expect((await f.service.available(f.actor, 16)).promotions).toEqual([]);
  });

  it.each(['ROLE', 'ALL', 'USERS'])(
    'retains explicitly assigned dealer offers for audience %s even with a better dealer price',
    async (audience) => {
      const f = fixture({ dealerMarkup: '0' });
      Object.assign(f.promotion, {
        audience,
        roleIds: [71, 82],
        userIds: [202],
      });
      const offers = (await f.service.available(f.actor, 16)).promotions;
      expect(offers).toHaveLength(1);
      expect(offers[0].percent).toBe('20');
      expect(offers[0].automaticDealerAdjustment).toBeUndefined();
    },
  );

  it('evaluates automatic offers from selected clients using their effective markup', async () => {
    const f = fixture({ dealerMarkup: '.1' });
    Object.assign(f.promotion, { audience: 'USERS', userIds: [101] });
    // The selected client pays 1.3 * .8 = 1.04, not the role-level 1.2.
    expect((await f.service.available(f.actor)).promotions).toHaveLength(1);
    f.user.markupOverride = new Prisma.Decimal('0');
    expect((await f.service.available(f.actor)).promotions).toEqual([]);
  });

  it('retains applied terms when reference markups change without repricing saved pieces', async () => {
    const f = fixture();
    // Los factores actuales coinciden; la pieza conserva una oferta anterior
    // calculada antes de que cambiara el markup de referencia del client.
    expect((await f.service.available(f.actor, 16)).promotions).toEqual([]);
    f.estimate.pieces.push({
      regularPrice: new Prisma.Decimal('120'),
      price: new Prisma.Decimal('110'),
      promotionSnapshot: {
        ...f.promotion,
        percent: '8.3333333333333333333',
        dealerPriceBasis: { regularPrice: '120', promotionalPrice: '110' },
        endsAt: f.promotion.endsAt.toISOString(),
        automaticDealerAdjustment: true,
      },
    });
    expect((await f.service.available(f.actor, 16)).promotions).toHaveLength(1);
    // A newly edited offer must not inherit the older version's saving.
    f.promotion.version = 2;
    expect((await f.service.available(f.actor, 16)).promotions).toEqual([]);
  });

  it('does not treat a stale snapshot with no actual saving as an applied benefit', async () => {
    const f = fixture({ dealerMarkup: '0' });
    f.estimate.pieces.push({
      regularPrice: new Prisma.Decimal(100),
      price: new Prisma.Decimal(100),
      promotionSnapshot: { ...f.promotion, percent: '20' },
    });
    expect((await f.service.available(f.actor, 16)).promotions).toEqual([]);
  });

  it('retains direct client banners and does not apply the dealer visibility rule to them', async () => {
    const f = fixture({ dealerMarkup: '0' });
    f.user.idRole = 71;
    f.user.role.name = 'client';
    const offers = (
      await f.service.available({ id: 202, role: { name: 'client' } })
    ).promotions;
    expect(offers).toHaveLength(1);
    expect(offers[0].percent).toBe('20');
  });
});

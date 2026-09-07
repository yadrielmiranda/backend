import { PromotionsService } from './promotions.service';
import { applyPromotion } from './promotion-pricing';
import Decimal from 'decimal.js';
import { validateSync } from 'class-validator';
import { PromotionDto } from './promotions.dto';
describe('Promotion audiences', () => {
  const rows = [
    {
      id: 1,
      version: 1,
      name: 'Client',
      percent: new Decimal(40),
      audience: 'ROLE',
      roleIds: [1],
      userIds: [],
    },
    {
      id: 2,
      version: 1,
      name: 'Dealer',
      percent: new Decimal(20),
      audience: 'ROLE',
      roleIds: [2],
      userIds: [],
    },
    {
      id: 3,
      version: 1,
      name: 'Selected',
      percent: new Decimal(50),
      audience: 'USERS',
      roleIds: [],
      userIds: [3],
    },
  ].map((p) => ({
    ...p,
    startsAt: new Date('2026-01-01'),
    endsAt: new Date('2027-01-01'),
    brandId: 1,
    productId: null,
    systemId: null,
  }));
  const db = (promotionRows = rows) => ({
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    system: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 3, idRole: 2, markupOverride: null }]),
      findUniqueOrThrow: jest.fn(({ where }) =>
        Promise.resolve({
          idRole:
            where.id === 1 ? 1 : where.id === 4 ? 3 : where.id === 5 ? 4 : 2,
          role: {
            name:
              where.id === 1
                ? 'client'
                : where.id === 4
                  ? 'admin'
                  : where.id === 5
                    ? 'operator'
                    : 'dealer',
          },
        }),
      ),
    },
    role: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, markup: new Decimal('.5') }),
    },
    promotion: { findMany: jest.fn().mockResolvedValue(promotionRows) },
    estimate: {
      findUnique: jest.fn().mockResolvedValue({
        idUser: 2,
        ownerMarkupSnapshot: new Decimal(0),
        pieces: [],
      }),
    },
  });
  it('filters the quote owner before comparing the same piece discounts', async () => {
    const service = new PromotionsService(db() as any);
    expect((await service.eligible(1)).map((p) => p.id)).toEqual([1]);
    expect((await service.eligible(2)).map((p) => p.id)).toEqual([1, 2]);
    expect((await service.eligible(3)).map((p) => p.id)).toEqual([1, 2, 3]);
  });
  it('uses the owner audience even when an admin opens the quote', async () => {
    const service = new PromotionsService(db() as any);
    expect(
      (
        await service.available({ id: 1, role: { name: 'admin' } }, 10)
      ).promotions.map((p) => p.id),
    ).toEqual([1, 2]);
  });
  it('does not expose promotions on another owners quote', async () => {
    const service = new PromotionsService(db() as any);
    await expect(
      service.available({ id: 1, role: { name: 'client' } }, 10),
    ).rejects.toThrow('Estimate not found');
  });

  it('applies one promotion to client OR dealer without including other roles', async () => {
    const combined = {
      ...rows[0],
      id: 4,
      name: 'Clients and dealers',
      roleIds: [1, 2],
    };
    const service = new PromotionsService(db([...rows, combined]) as any);
    expect((await service.eligible(1)).map((p) => p.id)).toEqual([1, 4]);
    expect((await service.eligible(2)).map((p) => p.id)).toEqual([1, 2, 4]);
    expect((await service.eligible(4)).map((p) => p.id)).toEqual([]);
    expect((await service.eligible(5)).map((p) => p.id)).toEqual([]);
    expect((await service.eligible(70)).map((p) => p.id)).toEqual([1, 2, 4]);
  });

  it('filters roles before choosing the highest matching discount', async () => {
    const combined = {
      ...rows[0],
      id: 4,
      percent: new Decimal(30),
      roleIds: [1, 2],
    };
    const admin = { ...rows[0], id: 5, percent: new Decimal(90), roleIds: [3] };
    const service = new PromotionsService(
      db([...rows, combined, admin]) as any,
    );
    const piece = {
      idBrand: 1,
      idProd: 2,
      idSyst: 3,
      qty: 1,
      rate: new Decimal(80),
      price: new Decimal(100),
      customerPrice: new Decimal(120),
      subtotal: new Decimal(100),
      customerSubtotal: new Decimal(120),
      netProfit: new Decimal(20),
      netProfitD: new Decimal(20),
    };
    expect(
      applyPromotion(piece, await service.eligible(1)).price.toString(),
    ).toBe('60');
    expect(
      applyPromotion(piece, await service.eligible(2)).price.toString(),
    ).toBe('70');
    expect(
      applyPromotion(piece, await service.eligible(3)).price.toString(),
    ).toBe('50');
  });

  it('preserves All users and Selected users without treating empty role selection as All users', async () => {
    const all = { ...rows[0], id: 4, audience: 'ALL', roleIds: [] };
    const emptyRoles = { ...rows[0], id: 5, roleIds: [] };
    const service = new PromotionsService(
      db([...rows, all, emptyRoles]) as any,
    );
    expect((await service.eligible(3)).map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect((await service.eligible(4)).map((p) => p.id)).toEqual([4]);
  });

  it('shows multi-role offers for the owner when an administrator views the estimate', async () => {
    const combined = { ...rows[0], id: 4, roleIds: [1, 2] };
    const service = new PromotionsService(db([...rows, combined]) as any);
    expect(
      (
        await service.available({ id: 4, role: { name: 'admin' } }, 10)
      ).promotions.map((p) => p.id),
    ).toEqual([1, 2, 4]);
  });
});

describe('Saving promotions with multiple roles', () => {
  const valid: PromotionDto = {
    name: 'Clients and dealers',
    percent: 20,
    audience: 'ROLE',
    roleIds: [1, 2],
    startsAt: '2026-09-07T00:00:00Z',
    endsAt: '2026-09-13T23:19:00Z',
    enabled: true,
  };
  function fixture() {
    const tx: any = {
      role: {
        count: jest.fn(
          async ({ where }) =>
            [...new Set(where.id.in)].filter((id) =>
              [1, 2, 3, 4].includes(id as number),
            ).length,
        ),
      },
      user: { count: jest.fn(async ({ where }) => where.id.in.length) },
      promotion: {
        findUnique: jest.fn().mockResolvedValue({ id: 1 }),
        create: jest.fn(async ({ data }) => ({ id: 1, version: 1, ...data })),
        update: jest.fn(async ({ data }) => ({ id: 1, ...data, version: 2 })),
      },
    };
    const service = new PromotionsService({
      $transaction: (fn) => fn(tx),
    } as any);
    return { tx, service };
  }

  it('saves both selected roles and clears an unrelated user selection', async () => {
    const f = fixture();
    const saved = await f.service.save({ ...valid, userIds: [8] });
    expect(saved.roleIds).toEqual([1, 2]);
    expect(saved.userIds).toEqual([]);
    expect(saved).not.toHaveProperty('roleId');
    expect(f.tx.role.count).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
    });
  });

  it('still accepts a single selected role', async () => {
    const f = fixture();
    expect((await f.service.save({ ...valid, roleIds: [2] })).roleIds).toEqual([
      2,
    ]);
  });

  it('updates the same promotion and increments its version', async () => {
    const f = fixture();
    await f.service.save({ ...valid, roleIds: [2, 3] }, 1);
    expect(f.tx.promotion.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        roleIds: [2, 3],
        version: { increment: 1 },
      }),
    });
    expect(f.tx.promotion.create).not.toHaveBeenCalled();
  });

  it.each([
    { roleIds: undefined },
    { roleIds: [] },
    { roleIds: [1, 999] },
    { roleIds: [1, 1] },
  ])(
    'rejects invalid selected roles %j without writing a promotion',
    async ({ roleIds }) => {
      const f = fixture();
      await expect(f.service.save({ ...valid, roleIds })).rejects.toThrow(
        'Select at least one valid role',
      );
      expect(f.tx.promotion.create).not.toHaveBeenCalled();
    },
  );

  it.each(['ALL', 'USERS'])(
    'clears role selection when changing the audience to %s',
    async (audience) => {
      const f = fixture();
      const saved = await f.service.save(
        { ...valid, audience, userIds: [8] },
        1,
      );
      expect(saved.roleIds).toEqual([]);
      expect(saved.userIds).toEqual(audience === 'USERS' ? [8] : []);
      expect(f.tx.role.count).not.toHaveBeenCalled();
    },
  );

  it('accepts numeric role arrays in the request DTO', () => {
    expect(validateSync(Object.assign(new PromotionDto(), valid))).toEqual([]);
  });

  it.each([
    { roleIds: [1, 1] },
    { roleIds: [0] },
    { roleIds: [-1] },
    { roleIds: [1.5] },
    { roleIds: ['1'] },
    { roleIds: '1,2' },
  ])('rejects invalid role array input %j', ({ roleIds }) => {
    const errors = validateSync(
      Object.assign(new PromotionDto(), valid, { roleIds }),
    );
    expect(errors.some((e) => e.property === 'roleIds')).toBe(true);
  });
});

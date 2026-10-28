import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MaterialsInventoryService } from './materials-inventory.service';

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };

function fixture(items: any[] = []) {
  const db = {
    materialMovement: { findMany: jest.fn().mockResolvedValue(items), count: jest.fn().mockResolvedValue(items.length) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { db, service: new MaterialsInventoryService(db as any) };
}

describe('Material movement history', () => {
  it('lists every material by default, newest first, with product units and pagination', async () => {
    const movement = { id: 31, actorId: null, recipient: null, product: { id: 10, name: 'Sealant', code: 'MAT-000010', baseUnit: { id: 4, name: 'Tube' } } };
    const { db, service } = fixture([movement]);
    const result = await service.history({ page: '2', pageSize: '10' }, operator);
    expect(db.materialMovement.findMany).toHaveBeenCalledWith({
      where: {}, orderBy: { id: 'desc' }, skip: 10, take: 10,
      include: {
        product: { select: { id: true, code: true, name: true, baseUnit: { select: { id: true, name: true } } } },
        presentation: { select: { id: true, name: true, multiplier: true } },
        store: { select: { id: true, name: true } },
      },
    });
    expect(result).toEqual({ items: [{ ...movement, actor: 'system' }], total: 1, page: 2, pageSize: 10 });
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('combines material, recipient, store, movement type and date filters for both rows and total', async () => {
    const { db, service } = fixture();
    await service.history({
      search: ' Sealant ', recipient: ' Juan ', storeId: '3', productId: '10', kind: 'INTERNAL_USE',
      from: '2026-10-01T00:00:00-04:00', to: '2026-11-01T00:00:00-04:00',
    }, admin);
    const where = db.materialMovement.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      productId: 10, storeId: 3, product: { OR: [{ name: { contains: 'Sealant' } }, { code: { contains: 'Sealant' } }] },
      recipient: { contains: 'Juan' }, kind: 'INTERNAL_USE',
      createdAt: { gte: new Date('2026-10-01T04:00:00Z'), lt: new Date('2026-11-01T04:00:00Z') },
    });
    expect(where).not.toHaveProperty('actorId');
    expect(db.materialMovement.count).toHaveBeenCalledWith({ where });
  });

  it('keeps the recipient separate from the person who recorded the withdrawal', async () => {
    const { db, service } = fixture([{ id: 1, actorId: 2, recipient: 'Juan Perez', kind: 'INTERNAL_USE' }]);
    db.user.findMany.mockResolvedValue([{ id: 2, firstName: ' Ana ', lastName: ' Lopez ', username: 'storeoperator' }]);
    const result = await service.history({ recipient: 'Juan' }, operator);
    expect(db.materialMovement.findMany.mock.calls[0][0].where).toEqual({ recipient: { contains: 'Juan' } });
    expect(result.items[0]).toMatchObject({ recipient: 'Juan Perez', actor: 'Ana Lopez', actorId: 2 });
  });

  it('resolves unique recorded-by accounts in one limited query and retains deleted-account fallback', async () => {
    const { db, service } = fixture([
      { id: 5, actorId: 2 }, { id: 4, actorId: 2 }, { id: 3, actorId: 3 }, { id: 2, actorId: 4 }, { id: 1, actorId: null },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: 2, firstName: 'Ana', lastName: 'Lopez', username: 'ana' },
      { id: 3, firstName: '', lastName: ' ', username: 'warehouse-manager' },
    ]);
    const result = await service.history({}, admin);
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [2, 3, 4] } }, select: { id: true, firstName: true, lastName: true, username: true },
    });
    expect(result.items.map(item => item.actor)).toEqual(['Ana Lopez', 'Ana Lopez', 'warehouse-manager', 'user #4', 'system']);
    expect(result.items[0]).not.toHaveProperty('username');
  });

  it('supports open-ended date filters and includes the start but excludes the end', async () => {
    const { db, service } = fixture();
    await service.history({ from: '2026-11-01T04:00:00.000Z' }, admin);
    const first = db.materialMovement.findMany.mock.calls[0][0].where.createdAt;
    expect(first).toEqual({ gte: new Date('2026-11-01T04:00:00Z') });
    await service.history({ to: '2026-11-02T05:00:00.000Z' }, admin);
    expect(db.materialMovement.findMany.mock.calls[1][0].where.createdAt).toEqual({ lt: new Date('2026-11-02T05:00:00Z') });
  });

  it('accepts a leap day and ignores cleared form filters', async () => {
    const { db, service } = fixture();
    await service.history({ from: '2028-02-29T00:00:00Z', search: ' ', recipient: '', kind: '', storeId: '' }, admin);
    expect(db.materialMovement.findMany.mock.calls[0][0].where).toEqual({ createdAt: { gte: new Date('2028-02-29T00:00:00Z') } });
  });

  it.each(['RECEIVE', 'INTERNAL_USE', 'OPEN', 'PACK', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUST', 'COUNT_ADJUSTMENT', 'SALE_DELIVERY'])(
    'can filter the existing %s movement type', async kind => {
      const { db, service } = fixture();
      await service.history({ kind }, admin);
      expect(db.materialMovement.count).toHaveBeenCalledWith({ where: { kind } });
    },
  );

  it.each([
    { productId: '-1' }, { storeId: '2.2' }, { productId: '2147483648' },
    { search: 'x'.repeat(151) }, { recipient: 'x'.repeat(201) }, { recipient: ['Juan'] },
    { kind: 'UNKNOWN' }, { kind: ['RECEIVE'] },
    { from: '2026-10-01' }, { from: '2026-10-01T00:00:00' },
    { from: '2026-02-29T00:00:00Z' }, { to: '2026-04-31T00:00:00Z' },
    { from: '2026-10-01T24:00:00Z' }, { to: '2026-10-01T00:00:00+24:00' },
    { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    { from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  ])('rejects invalid filters before reading history: %j', async query => {
    const { db, service } = fixture();
    await expect(service.history(query as any, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.materialMovement.findMany).not.toHaveBeenCalled();
    expect(db.materialMovement.count).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it.each(['technician', 'dealer', 'customer'])('does not expose staff history to %s', async role => {
    const { db, service } = fixture();
    await expect(service.history({}, { id: 3, role: { name: role } } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.materialMovement.findMany).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

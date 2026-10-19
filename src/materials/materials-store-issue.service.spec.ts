import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MaterialsInventoryService } from './materials-inventory.service';
import { MaterialsStoreIssueService } from './materials-store-issue.service';
import { MaterialStoreIssueDto } from './materials-store-issue.dto';

const admin = { id: 7, role: { name: 'admin' } } as const;
const operator = { id: 8, role: { name: 'operator' } } as const;
const client = { id: 9, role: { name: 'client' } } as const;
const requestKey = '8a99dc20-45a2-42d9-9e5b-05b9b3134623';
const otherKey = '8a99dc20-45a2-42d9-9e5b-05b9b3134624';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture(count = 2) {
  let db = {
    stores: [{ id: 3, name: 'Main warehouse', isActive: true }, { id: 4, name: 'Other warehouse', isActive: true }],
    products: Array.from({ length: count }, (_, index) => ({
      id: index + 1, name: `Material ${index + 1}`, version: 4, isActive: true, isSaleEnabled: false, allowBaseUnitOperations: true,
      presentations: [
        { id: (index + 1) * 10 + 1, name: 'Tube', isBase: true, isActive: true, multiplier: 1 },
        { id: (index + 1) * 10 + 2, name: 'Box', isBase: false, isActive: true, multiplier: 12 },
      ],
    })),
    stocks: Array.from({ length: count }, (_, index) => [
      { productId: index + 1, presentationId: (index + 1) * 10 + 2, storeId: 3, quantity: 10, version: 1 },
      { productId: index + 1, presentationId: (index + 1) * 10 + 2, storeId: 4, quantity: 4, version: 1 },
    ]).flat(),
    reservations: [] as { productId: number; presentationId: number; storeId: number; quantity: number; status: string }[],
    operations: {} as Record<string, any>, movements: [] as any[],
  };
  const tx: any = {
    warehouseStore: { findUnique: jest.fn(async ({ where }) => clone(db.stores.find(row => row.id === where.id) ?? null)) },
    materialProduct: {
      findMany: jest.fn(async ({ where }) => clone(db.products.filter(product => where.id.in.includes(product.id)))),
      update: jest.fn(async ({ where }) => { const product = db.products.find(row => row.id === where.id)!; product.version++; return clone(product); }),
    },
    materialStock: {
      findMany: jest.fn(async ({ where }) => clone(db.stocks.filter(row => row.storeId === where.storeId && where.productId.in.includes(row.productId)))),
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = db.stocks.find(stock => stock.storeId === where.presentationId_storeId.storeId && stock.presentationId === where.presentationId_storeId.presentationId);
        if (row) { row.quantity = update.quantity; row.version++; return clone(row); }
        db.stocks.push({ ...create, version: 0 }); return { ...create, version: 0 };
      }),
    },
    materialSaleLine: { findMany: jest.fn(async ({ where }) => clone(db.reservations.filter(row => row.storeId === where.storeId && where.productId.in.includes(row.productId) && row.status === where.sale.status))) },
    materialOperation: {
      findUnique: jest.fn(async ({ where }) => clone(db.operations[where.requestKey] ?? null)),
      create: jest.fn(async ({ data }) => { db.operations[data.requestKey] = clone(data); return clone(data); }),
      update: jest.fn(async ({ where, data }) => { Object.assign(db.operations[where.requestKey], clone(data)); return clone(db.operations[where.requestKey]); }),
    },
    materialMovement: { create: jest.fn(async ({ data }) => { const movement = { id: db.movements.length + 1, ...clone(data) }; db.movements.push(movement); return movement; }) },
    $queryRaw: jest.fn(async (parts, id) => {
      const rows = parts.join('').includes('material_products') ? db.products : db.stores;
      return rows.some(row => row.id === id) ? [{ id }] : [];
    }),
  };
  const prisma: any = { $transaction: jest.fn(async work => {
    const original = clone(db);
    try { return await work(tx); } catch (error) { db = original; throw error; }
  }) };
  const inventory = new MaterialsInventoryService(prisma);
  const service = new MaterialsStoreIssueService(prisma, inventory);
  const payload = (lines = [{ productId: 1, presentationId: 11, quantity: 3 }]): MaterialStoreIssueDto => ({ requestKey, recipient: ' Technician Juan ', note: ' Installation 456 ', lines });
  const quantity = (id: number, storeId = 3) => db.stocks.find(row => row.presentationId === id && row.storeId === storeId)?.quantity ?? 0;
  return { service, inventory, prisma, tx, payload, quantity, db: () => db };
}

describe('Atomic material store internal use', () => {
  it('rejects a restricted base or 1x-alias in a batch before issuing any other product', async () => {
    for (const isBase of [true, false]) {
      const f = fixture();
      f.db().products[1].allowBaseUnitOperations = false;
      f.db().products[1].presentations[0].isBase = isBase;
      if (!isBase) f.db().products[1].presentations.push({ id: 23, name: 'Base', multiplier: 1, isBase: true, isActive: true });
      const before = clone(f.db());
      await expect(f.service.internalUse(3, f.payload([
        { productId: 1, presentationId: 12, quantity: 1 }, { productId: 2, presentationId: 21, quantity: 1 },
      ]), operator)).rejects.toThrow('complete packages only');
      expect(f.db()).toEqual(before);
      expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
    }
  });

  it('allows complete packages of a restricted material in bulk issues', async () => {
    const f = fixture();
    f.db().products[0].allowBaseUnitOperations = false;
    await f.service.internalUse(3, f.payload([{ productId: 1, presentationId: 12, quantity: 2 }]), operator);
    expect([f.quantity(12), f.quantity(11)]).toEqual([8, 0]);
  });

  it('issues multiple internal-only products from the selected store and records each line without prices', async () => {
    const f = fixture();
    const result = await f.service.internalUse(3, f.payload([
      { productId: 2, presentationId: 22, quantity: 2 }, { productId: 1, presentationId: 11, quantity: 3 },
    ]), operator);
    expect(result).toMatchObject({ storeId: 3, storeName: 'Main warehouse', recipient: 'Technician Juan', note: 'Installation 456', productCount: 2, lineCount: 2, movementIds: [1, 2], replayed: false });
    expect(result.issuedAt).toEqual(expect.any(String));
    expect([f.quantity(11), f.quantity(12), f.quantity(22)]).toEqual([9, 9, 8]);
    expect([f.quantity(12, 4), f.quantity(22, 4)]).toEqual([4, 4]);
    expect(f.db().movements).toHaveLength(2);
    for (const movement of f.db().movements) {
      expect(movement).toMatchObject({ operationKey: requestKey, kind: 'INTERNAL_USE', actorId: 8, recipient: 'Technician Juan', note: 'Installation 456', details: { source: 'STORE_INTERNAL_USE' } });
      expect(movement.costPerPackage).toBeUndefined();
      expect(movement.totalCost).toBeUndefined();
      expect(movement.saleId).toBeUndefined();
    }
    expect(f.db().movements[0]).toMatchObject({ presentationId: 11, quantity: 3, deltaBaseUnits: -3,
      details: { opened: [{ presentationId: 12, quantity: 1, baseUnits: 12 }] } });
    expect(f.db().operations[requestKey].kind).toBe('STORE_INTERNAL_USE');
    expect(f.tx.materialProduct.findMany.mock.calls[0][0].where).not.toHaveProperty('isSaleEnabled');
  });

  it('withdraws requested whole packages before loose units even when input starts with the base presentation', async () => {
    const f = fixture();
    f.db().stocks[0].quantity = 2;
    const result = await f.service.internalUse(3, f.payload([
      { productId: 1, presentationId: 11, quantity: 1 }, { productId: 1, presentationId: 12, quantity: 1 },
    ]), admin);
    expect(result).toMatchObject({ productCount: 1, lineCount: 2 });
    expect(f.db().movements.map(row => row.presentationId)).toEqual([12, 11]);
    expect([f.quantity(12), f.quantity(11)]).toEqual([0, 11]);
    expect(f.db().movements.map(row => row.baseUnitsAfter)).toEqual([12, 11]);
  });

  it('rejects a combined box and loose request that individually fits but together exceeds stock', async () => {
    const f = fixture();
    f.db().stocks[0].quantity = 1;
    const before = clone(f.db());
    await expect(f.service.internalUse(3, f.payload([
      { productId: 1, presentationId: 11, quantity: 1 }, { productId: 1, presentationId: 12, quantity: 1 },
    ]), admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db()).toEqual(before);
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
  });

  it('validates every product before saving stock so a later insufficient product does not issue earlier lines', async () => {
    const f = fixture();
    f.db().stocks.find(row => row.presentationId === 22 && row.storeId === 3)!.quantity = 0;
    const before = clone(f.db());
    await expect(f.service.internalUse(3, f.payload([
      { productId: 1, presentationId: 11, quantity: 3 }, { productId: 2, presentationId: 22, quantity: 1 },
    ]), admin)).rejects.toThrow('Material 2');
    expect(f.db()).toEqual(before);
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
  });

  it('rolls back all stock, versions, movements and request records if saving a later movement fails', async () => {
    const f = fixture();
    const original = f.tx.materialMovement.create.getMockImplementation();
    f.tx.materialMovement.create.mockImplementationOnce(original).mockRejectedValueOnce(new Error('Storage unavailable'));
    const before = clone(f.db());
    await expect(f.service.internalUse(3, f.payload([
      { productId: 1, presentationId: 11, quantity: 3 }, { productId: 2, presentationId: 22, quantity: 1 },
    ]), admin)).rejects.toThrow('Storage unavailable');
    expect(f.db()).toEqual(before);
  });

  it('preserves both whole-package and loose reservations while automatically opening only a free box', async () => {
    const f = fixture();
    f.db().stocks[0].quantity = 3;
    f.db().reservations.push(
      { productId: 1, presentationId: 12, storeId: 3, quantity: 1, status: 'CONFIRMED' },
      { productId: 1, presentationId: 11, storeId: 3, quantity: 6, status: 'CONFIRMED' },
      { productId: 1, presentationId: 12, storeId: 3, quantity: 3, status: 'CANCELED' },
      { productId: 1, presentationId: 12, storeId: 4, quantity: 4, status: 'CONFIRMED' },
    );
    await f.service.internalUse(3, f.payload([
      { productId: 1, presentationId: 12, quantity: 1 }, { productId: 1, presentationId: 11, quantity: 6 },
    ]), operator);
    expect([f.quantity(12), f.quantity(11)]).toEqual([1, 6]);
  });

  it('uses current reservations even when product version has not changed', async () => {
    const f = fixture();
    f.db().reservations.push({ productId: 1, presentationId: 11, storeId: 3, quantity: 120, status: 'CONFIRMED' });
    await expect(f.service.internalUse(3, f.payload(), admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db().products[0].version).toBe(4);
    expect(f.db().movements).toHaveLength(0);
    const reservationCall = f.tx.materialSaleLine.findMany.mock.invocationCallOrder[0];
    expect(reservationCall).toBeGreaterThan(Math.max(...f.tx.$queryRaw.mock.invocationCallOrder));
  });

  it('allows a full 250-product issue without truncation and batches snapshot reads', async () => {
    const f = fixture(250);
    const lines = f.db().products.map(product => ({ productId: product.id, presentationId: product.id * 10 + 2, quantity: 1 }));
    const result = await f.service.internalUse(3, f.payload(lines), operator);
    expect(result).toMatchObject({ productCount: 250, lineCount: 250 });
    expect(result.movementIds).toHaveLength(250);
    for (const model of ['materialProduct', 'materialStock', 'materialSaleLine']) expect(f.tx[model].findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRaw.mock.calls.slice(0, 250).map(call => call[1])).toEqual(lines.map(line => line.productId));
    expect(f.tx.$queryRaw.mock.calls[250][0].join('')).toContain('warehouse_stores');
  });

  it('returns the original result on retry after other stock movements, without withdrawing twice', async () => {
    const f = fixture();
    const dto = f.payload([{ productId: 2, presentationId: 22, quantity: 1 }, { productId: 1, presentationId: 11, quantity: 3 }]);
    const first = await f.service.internalUse(3, dto, admin);
    await f.service.internalUse(3, { ...f.payload(), requestKey: otherKey }, admin);
    const after = clone(f.db());
    const replay = await f.service.internalUse(3, { ...dto, lines: [...dto.lines].reverse() }, admin);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.db()).toEqual(after);
  });

  it('rejects reuse of a request for changed lines, recipient, store or actor', async () => {
    const f = fixture();
    const dto = f.payload();
    await f.service.internalUse(3, dto, admin);
    await expect(f.service.internalUse(3, { ...dto, recipient: 'Other technician' }, admin)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.internalUse(3, f.payload([{ productId: 1, presentationId: 11, quantity: 4 }]), admin)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.internalUse(4, dto, admin)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.internalUse(3, dto, operator)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db().movements).toHaveLength(1);
  });

  it.each(['client', 'dealer', 'installer', 'sales'])('blocks the %s role', async role => {
    const f = fixture();
    await expect(f.service.internalUse(3, f.payload(), { ...client, role: { name: role } } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['store', 'product', 'presentation'])('rejects an inactive %s', async kind => {
    const f = fixture();
    if (kind === 'store') f.db().stores[0].isActive = false;
    if (kind === 'product') f.db().products[0].isActive = false;
    if (kind === 'presentation') f.db().products[0].presentations[0].isActive = false;
    await expect(f.service.internalUse(3, f.payload(), admin)).rejects.toThrow(/inactive|active/);
    expect(f.db().movements).toHaveLength(0);
  });

  it('rejects missing stores/products and presentations belonging to another product', async () => {
    const f = fixture();
    await expect(f.service.internalUse(99, f.payload(), admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.internalUse(3, f.payload([{ productId: 99, presentationId: 11, quantity: 1 }]), admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.internalUse(3, f.payload([{ productId: 2, presentationId: 11, quantity: 1 }]), admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.db().movements).toHaveLength(0);
  });

  it('rejects duplicate presentations, empty batch, excessive lines, whitespace metadata and malformed request IDs', async () => {
    const f = fixture();
    const dto = f.payload();
    for (const invalid of [
      { ...dto, lines: [...dto.lines, ...dto.lines] }, { ...dto, lines: [] },
      { ...dto, lines: Array.from({ length: 1001 }, () => dto.lines[0]) },
      { ...dto, recipient: '  ' }, { ...dto, recipient: 'a'.repeat(201) },
      { ...dto, note: '\n' }, { ...dto, note: 'a'.repeat(1001) }, { ...dto, requestKey: 'fake' },
    ]) await expect(f.service.internalUse(3, invalid, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('Store issue input validation', () => {
  it.each(['', '1', false, true, null, 0, -1, 1.5, 1000001, {}, []])('rejects nonpositive or nonnumeric issue quantity %j despite implicit conversion', async value => {
    const f = fixture();
    const dto = { ...f.payload(), lines: [{ productId: 1, presentationId: 11, quantity: value }] };
    const transformed = plainToInstance(MaterialStoreIssueDto, dto, { enableImplicitConversion: true });
    expect(validateSync(transformed)).not.toHaveLength(0);
    await expect(f.service.internalUse(3, dto as any, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['productId', 'presentationId'])('rejects coercion of %s from JSON strings and booleans', field => {
    const f = fixture();
    for (const value of ['1', '', false, true, null]) {
      const dto = { ...f.payload(), lines: [{ ...f.payload().lines[0], [field]: value }] };
      expect(validateSync(plainToInstance(MaterialStoreIssueDto, dto, { enableImplicitConversion: true }))).not.toHaveLength(0);
    }
  });

  it('accepts genuine numeric quantities and rejects coerced recipient or note types', () => {
    const f = fixture();
    expect(validateSync(plainToInstance(MaterialStoreIssueDto, f.payload(), { enableImplicitConversion: true }))).toHaveLength(0);
    for (const field of ['recipient', 'note']) {
      expect(validateSync(plainToInstance(MaterialStoreIssueDto, { ...f.payload(), [field]: 123 }, { enableImplicitConversion: true }))).not.toHaveLength(0);
    }
  });
});

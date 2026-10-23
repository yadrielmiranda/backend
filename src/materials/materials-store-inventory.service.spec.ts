import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MaterialsInventoryService } from './materials-inventory.service';
import { MaterialsStoreInventoryService } from './materials-store-inventory.service';
import { MaterialStoreCountDto } from './materials-store-inventory.dto';

const admin = { id: 7, role: { name: 'admin' } } as const;
const operator = { id: 8, role: { name: 'operator' } } as const;
const client = { id: 9, role: { name: 'client' } } as const;
const requestKey = 'edfe9c97-8b18-42e7-ab72-f9c14b8c1955';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture(count = 2) {
  let db = {
    store: { id: 3, name: 'Main warehouse', isActive: true },
    products: Array.from({ length: count }, (_, index) => ({
      id: index + 1, name: `Material ${index + 1}`, code: `MAT-${index + 1}`, imageUrl: null,
      version: 4, isActive: true, allowBaseUnitOperations: true, baseUnit: { id: 1, name: 'Tube' },
    })),
    presentations: Array.from({ length: count }, (_, index) => [
      { id: (index + 1) * 10 + 1, productId: index + 1, name: 'Tube', barcode: null, isBase: true, isActive: true, multiplier: 1 },
      { id: (index + 1) * 10 + 2, productId: index + 1, name: 'Box', barcode: null, isBase: false, isActive: true, multiplier: 12 },
    ]).flat(),
    stocks: [{ productId: 1, presentationId: 12, storeId: 3, quantity: 10, version: 1 }],
    reservations: [] as { productId: number; presentationId: number; storeId: number; quantity: number; status: string }[],
    operations: {} as Record<string, any>,
    movements: [] as any[],
  };
  const tx: any = {
    warehouseStore: { findUnique: jest.fn(async ({ where }) => where.id === db.store.id ? clone(db.store) : null) },
    materialProduct: {
      findMany: jest.fn(async ({ where }) => clone(db.products.filter(product => where.id
        ? where.id.in.includes(product.id)
        : product.isActive || db.stocks.some(stock => stock.productId === product.id && stock.storeId === 3 && stock.quantity > 0)
          || db.reservations.some(row => row.productId === product.id && row.storeId === 3 && row.status === 'CONFIRMED' && row.quantity > 0)))),
      update: jest.fn(async ({ where }) => { const product = db.products.find(row => row.id === where.id)!; product.version++; return clone(product); }),
    },
    materialPresentation: { findMany: jest.fn(async ({ where }) => clone(db.presentations.filter(row => where.productId.in.includes(row.productId)))) },
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
      findUnique: jest.fn(async ({ where }) => db.operations[where.requestKey] ? clone(db.operations[where.requestKey]) : null),
      create: jest.fn(async ({ data }) => { db.operations[data.requestKey] = clone(data); return clone(data); }),
      update: jest.fn(async ({ where, data }) => { Object.assign(db.operations[where.requestKey], clone(data)); return clone(db.operations[where.requestKey]); }),
    },
    materialMovement: { create: jest.fn(async ({ data }) => { const movement = { id: db.movements.length + 1, ...clone(data) }; db.movements.push(movement); return movement; }) },
    $queryRaw: jest.fn(async (parts, id) => {
      if (parts.join('').includes('material_products')) return db.products.some(row => row.id === id) ? [{ id }] : [];
      return db.store.id === id ? [{ id }] : [];
    }),
  };
  const prisma: any = { $transaction: jest.fn(async work => {
    const original = clone(db);
    try { return await work(tx); } catch (error) { db = original; throw error; }
  }) };
  const inventory = new MaterialsInventoryService(prisma);
  const service = new MaterialsStoreInventoryService(prisma, inventory);
  const payload = (products = [{ productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 9 }] }]) => ({ requestKey, note: 'Physical count', products });
  return { service, inventory, prisma, tx, payload, db: () => db };
}

describe('Materials store inventory snapshot', () => {
  it('offers technicians the same safe withdrawal availability without granting staff inventory or count access', async () => {
    const f = fixture();
    const technician = { id: 12, role: { name: 'technician' } } as const;
    f.db().reservations.push({ productId: 1, presentationId: 12, storeId: 3, quantity: 2, status: 'CONFIRMED' });
    const result = await f.service.getTechnicianInventory(3, technician);
    expect(result.products[0]).toMatchObject({ totalBaseQuantity: 120, reservedBaseQuantity: 24, availableBaseQuantity: 96 });
    const query = f.tx.materialProduct.findMany.mock.calls[0][0];
    for (const field of ['costPerPackage', 'baseCost', 'salePrice', 'saleLines']) expect(query.select).not.toHaveProperty(field);
    await expect(f.service.getInventory(3, technician)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.count(3, f.payload(), technician)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.getTechnicianInventory(3, operator)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.getTechnicianInventory(3, client)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db().movements).toHaveLength(0);
  });

  it('exposes the policy to daily operations while allowing admin physical counts of restricted base quantities', async () => {
    const f = fixture();
    f.db().products[0].allowBaseUnitOperations = false;
    const snapshot = await f.service.getInventory(3, operator);
    expect(snapshot.products[0].allowBaseUnitOperations).toBe(false);
    expect(f.tx.materialProduct.findMany.mock.calls[0][0].select.allowBaseUnitOperations).toBe(true);
    await f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [{ presentationId: 11, quantity: 7 }] }]), admin);
    expect(f.db().stocks.find(stock => stock.presentationId === 11)?.quantity).toBe(7);
  });

  it('reads all 250 products, including zero stock, in one consistent batched transaction', async () => {
    const f = fixture(250);
    const result = await f.service.getInventory(3, operator);
    expect(result.products).toHaveLength(250);
    expect(result.products[1]).toMatchObject({ totalBaseQuantity: 0, availableBaseQuantity: 0 });
    expect(result.products[0]).toMatchObject({ totalBaseQuantity: 120, presentations: [
      { id: 11, quantity: 0, multiplier: 1, availableQuantity: 120 }, { id: 12, quantity: 10, multiplier: 12, availableQuantity: 10 },
    ] });
    for (const model of ['materialProduct', 'materialPresentation', 'materialStock', 'materialSaleLine'])
      expect(f.tx[model].findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
    const query = f.tx.materialProduct.findMany.mock.calls[0][0];
    expect(query).not.toHaveProperty('take');
    expect(query).not.toHaveProperty('skip');
    expect(query.where).not.toHaveProperty('isSaleEnabled');
    expect(query.select).not.toHaveProperty('salePrice');
  });

  it('includes inactive stock rows for review but omits inactive, empty products and presentations', async () => {
    const f = fixture(3);
    f.db().products[0].isActive = false;
    f.db().products[2].isActive = false;
    f.db().presentations.find(row => row.id === 12)!.isActive = false;
    f.db().presentations.push({ id: 13, productId: 1, name: 'Bag', barcode: null, isBase: false, isActive: false, multiplier: 3 });
    const result = await f.service.getInventory(3, admin);
    expect(result.products.map(row => row.id)).toEqual([1, 2]);
    expect(result.products[0].isActive).toBe(false);
    expect(result.products[0].presentations.map(row => row.id)).toEqual([11, 12]);
    expect(result.products[0].presentations[1]).toMatchObject({ isActive: false, quantity: 10 });
  });

  it('counts all physical stock, including reserved packages and loose-unit reservations', async () => {
    const f = fixture();
    f.db().reservations.push({ productId: 1, presentationId: 12, storeId: 3, quantity: 2, status: 'CONFIRMED' },
      { productId: 1, presentationId: 11, storeId: 3, quantity: 3, status: 'CONFIRMED' },
      { productId: 1, presentationId: 12, storeId: 3, quantity: 9, status: 'CANCELED' });
    const result = await f.service.getInventory(3, admin);
    expect(result.products[0]).toMatchObject({ totalBaseQuantity: 120, reservedBaseQuantity: 27, availableBaseQuantity: 93 });
    expect(result.products[0].presentations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 12, reservedQuantity: 2, availableQuantity: 7 }),
      expect.objectContaining({ id: 11, availableQuantity: 93 }),
    ]));
    expect(f.tx.materialStock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ storeId: 3 }) }));
  });

  it('rejects nonstaff and invalid or missing stores before exposing inventory', async () => {
    const f = fixture();
    await expect(f.service.getInventory(3, client)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    await expect(f.service.getInventory(0, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.getInventory(99, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Atomic material store counts', () => {
  it('records a full 250-product count without truncating matched or zero quantities', async () => {
    const f = fixture(250);
    const products = f.db().products.map(product => ({ productId: product.id, version: product.version,
      counts: [{ presentationId: product.id * 10 + 1, quantity: 0 },
        { presentationId: product.id * 10 + 2, quantity: product.id === 1 ? 10 : 0 }],
    }));
    const result = await f.service.count(3, f.payload(products), admin);
    expect(result).toMatchObject({ countedProducts: 250, countedPresentations: 500, adjustedProducts: 0 });
    expect(f.db().operations[requestKey].result.audit.countedItems).toHaveLength(250);
    expect(f.tx.materialPresentation.findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.materialStock.findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.materialSaleLine.findMany).toHaveBeenCalledTimes(1);
  });

  it('accepts explicit zero and leaves omitted presentations, products and stores unchanged', async () => {
    const f = fixture();
    f.db().stocks.push({ productId: 1, presentationId: 11, storeId: 3, quantity: 7, version: 1 },
      { productId: 2, presentationId: 22, storeId: 3, quantity: 8, version: 1 },
      { productId: 1, presentationId: 12, storeId: 9, quantity: 4, version: 1 });
    const result = await f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 0 }] }]), admin);
    expect(result).toMatchObject({ countedProducts: 1, countedPresentations: 1, adjustedProducts: 1, movementIds: [1], replayed: false });
    expect(result).not.toHaveProperty('audit');
    expect(f.db().stocks.map(row => row.quantity)).toEqual([0, 7, 8, 4]);
    expect(f.db().movements[0]).toMatchObject({ kind: 'COUNT_ADJUSTMENT', presentationId: 11, quantity: 7, deltaBaseUnits: -120,
      actorId: 7, details: { source: 'STORE_COUNT', changes: [{ presentationId: 12, before: 10, after: 0 }], countedPresentations: [{ presentationId: 12, quantity: 0 }] } });
  });

  it('validates simultaneous box and loose counts against the final reservation-safe state', async () => {
    const f = fixture();
    f.db().reservations.push({ productId: 1, presentationId: 11, quantity: 120, storeId: 3, status: 'CONFIRMED' });
    const result = await f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [
      { presentationId: 12, quantity: 9 }, { presentationId: 11, quantity: 12 },
    ] }]), admin);
    expect(result.adjustedProducts).toBe(1);
    expect(f.db().movements[0]).toMatchObject({ deltaBaseUnits: 0, baseUnitsAfter: 120 });
    expect(f.db().movements).toHaveLength(1);
    expect(f.db().products[0].version).toBe(5);
    expect(f.db().stocks.find(row => row.presentationId === 11)?.quantity).toBe(12);
  });

  it('protects whole-package reservations even when enough loose units exist', async () => {
    const f = fixture();
    f.db().reservations.push({ productId: 1, presentationId: 12, quantity: 10, storeId: 3, status: 'CONFIRMED' });
    await expect(f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [
      { presentationId: 12, quantity: 9 }, { presentationId: 11, quantity: 12 },
    ] }]), admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db().stocks[0].quantity).toBe(10);
    expect(f.db().operations).toEqual({});
  });

  it('rechecks new reservations after locks even when the product version has not changed', async () => {
    const f = fixture();
    const original = f.inventory.lockProducts.bind(f.inventory);
    jest.spyOn(f.inventory, 'lockProducts').mockImplementation(async (tx, ids) => {
      await original(tx, ids);
      f.db().reservations.push({ productId: 1, presentationId: 11, quantity: 120, storeId: 3, status: 'CONFIRMED' });
    });
    await expect(f.service.count(3, f.payload(), admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
    expect(f.tx.materialSaleLine.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(f.tx.$queryRaw.mock.invocationCallOrder[1]);
  });

  it('validates all products before applying any adjustment', async () => {
    const f = fixture();
    await expect(f.service.count(3, f.payload([
      { productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 9 }] },
      { productId: 2, version: 2, counts: [{ presentationId: 22, quantity: 1 }] },
    ]), admin)).rejects.toThrow('Stock changed');
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
    expect(f.db().operations).toEqual({});
  });

  it('rolls the entire batch back if a later movement write fails', async () => {
    const f = fixture();
    const original = f.tx.materialMovement.create.getMockImplementation();
    f.tx.materialMovement.create.mockImplementationOnce(original).mockRejectedValueOnce(new Error('Database failure'));
    await expect(f.service.count(3, f.payload([
      { productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 9 }] },
      { productId: 2, version: 4, counts: [{ presentationId: 22, quantity: 1 }] },
    ]), admin)).rejects.toThrow('Database failure');
    expect(f.tx.materialMovement.create).toHaveBeenCalledTimes(2);
    expect(f.db().stocks).toEqual([{ productId: 1, presentationId: 12, storeId: 3, quantity: 10, version: 1 }]);
    expect(f.db().products.map(row => row.version)).toEqual([4, 4]);
    expect(f.db().movements).toEqual([]);
    expect(f.db().operations).toEqual({});
  });

  it('records unchanged counted quantities without manufacturing movement or version changes', async () => {
    const f = fixture();
    const result = await f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 10 }] }]), admin);
    expect(result).toMatchObject({ countedProducts: 1, countedPresentations: 1, adjustedProducts: 0, movementIds: [] });
    expect(f.db().products[0].version).toBe(4);
    expect(f.db().operations[requestKey]).toMatchObject({ kind: 'STORE_COUNT', actorId: 7,
      result: { audit: { note: 'Physical count', countedItems: [{ productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 10 }] }] } } });
  });

  it('replays the original result without reapplying after stock changes or store deactivation', async () => {
    const f = fixture();
    const dto = f.payload();
    const first = await f.service.count(3, dto, admin);
    f.db().stocks[0].quantity = 7;
    f.db().store.isActive = false;
    const replay = await f.service.count(3, dto, admin);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(replay).not.toHaveProperty('audit');
    expect(f.db().stocks[0].quantity).toBe(7);
    expect(f.db().movements).toHaveLength(1);
  });

  it('rejects changed payload or actor for the same operation key', async () => {
    const f = fixture();
    await f.service.count(3, f.payload(), admin);
    await expect(f.service.count(3, { ...f.payload(), note: 'Different' }, admin)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.count(3, f.payload(), { ...admin, id: 100 })).rejects.toBeInstanceOf(ConflictException);
    expect(f.db().movements).toHaveLength(1);
  });

  it('locks selected products in stable order before locking the store', async () => {
    const f = fixture();
    await f.service.count(3, f.payload([
      { productId: 2, version: 4, counts: [{ presentationId: 22, quantity: 1 }] },
      { productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 9 }] },
    ]), admin);
    expect(f.tx.$queryRaw.mock.calls.map(call => call[1])).toEqual([1, 2, 3]);
    expect(f.tx.$queryRaw.mock.calls[2][0].join('')).toContain('warehouse_stores');
  });

  it.each([operator, client, { id: 10, role: { name: 'technician' } }])('restricts count commits to admins (%j)', async actor => {
    const f = fixture();
    await expect(f.service.count(3, f.payload(), actor as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['store', 'product', 'presentation'])('rejects inactive %s without stock writes', async kind => {
    const f = fixture();
    if (kind === 'store') f.db().store.isActive = false;
    if (kind === 'product') f.db().products[0].isActive = false;
    if (kind === 'presentation') f.db().presentations.find(row => row.id === 12)!.isActive = false;
    await expect(f.service.count(3, f.payload(), admin)).rejects.toThrow(/inactive|active presentations/);
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
  });

  it('rejects a presentation belonging to another product', async () => {
    const f = fixture();
    await expect(f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [{ presentationId: 22, quantity: 1 }] }]), admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.db().movements).toEqual([]);
  });

  it.each([-1, 0.5, 1000001, NaN, Infinity, null, '', '0', undefined])('rejects invalid counted quantity %p rather than treating it as zero', async quantity => {
    const f = fixture();
    const dto = f.payload();
    dto.products[0].counts[0].quantity = quantity as any;
    await expect(f.service.count(3, dto, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['product', 'presentation', 'version', 'note', 'emptyProducts', 'emptyCounts'])('rejects malformed or duplicated %s input', async kind => {
    const f = fixture();
    const dto = f.payload();
    if (kind === 'product') dto.products.push(clone(dto.products[0]));
    if (kind === 'presentation') dto.products[0].counts.push(clone(dto.products[0].counts[0]));
    if (kind === 'version') delete (dto.products[0] as any).version;
    if (kind === 'note') dto.note = '   ';
    if (kind === 'emptyProducts') dto.products = [];
    if (kind === 'emptyCounts') dto.products[0].counts = [];
    await expect(f.service.count(3, dto, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects total base quantities beyond the inventory integer limit', async () => {
    const f = fixture();
    f.db().presentations.find(row => row.id === 12)!.multiplier = 1000000;
    await expect(f.service.count(3, f.payload([{ productId: 1, version: 4, counts: [{ presentationId: 12, quantity: 1000000 }] }]), admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.materialStock.upsert).not.toHaveBeenCalled();
  });
});

describe('Store count nested DTO', () => {
  it('validates nested quantities and requires versions, while preserving explicit zero', () => {
    const f = fixture();
    const valid = f.payload([{ productId: 1, version: 0, counts: [{ presentationId: 12, quantity: 0 }] }]);
    expect(validateSync(plainToInstance(MaterialStoreCountDto, valid))).toEqual([]);
    for (const quantity of [-1, 1.5, null, '', '0', false, 1000001]) {
      const invalid = clone(valid);
      invalid.products[0].counts[0].quantity = quantity as any;
      expect(validateSync(plainToInstance(MaterialStoreCountDto, invalid, { enableImplicitConversion: true }))).not.toEqual([]);
    }
  });
});

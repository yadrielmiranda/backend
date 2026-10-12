import { randomUUID } from 'crypto';
import { MaterialsInventoryService } from './materials-inventory.service';

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const request = () => ({ requestKey: randomUUID() });

function fixture() {
  let data = {
    units: [{ id: 1, name: 'Tube', isActive: true }, { id: 2, name: 'Box', isActive: true }, { id: 3, name: 'Bag', isActive: true }],
    categories: [] as any[],
    products: [] as any[], presentations: [] as any[], stocks: [] as any[], operations: [] as any[], movements: [] as any[], lines: [] as any[],
    stores: [{ id: 1, name: 'A', isActive: true }, { id: 2, name: 'B', isActive: true }],
  };
  const locks: string[] = [];
  const queryMatch = (row: any, where: any = {}) => Object.entries(where).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === 'sale') return row.sale?.status === value.status;
    if (value && typeof value === 'object') {
      if ('gt' in value) return row[key] > value.gt;
      if ('not' in value) return row[key] !== value.not;
      return true;
    }
    return row[key] === value;
  });
  const patch = (row: any, update: any) => {
    for (const [key, value] of Object.entries(update)) if (value !== undefined) {
      row[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] ?? 0) + value.increment : value;
    }
    return row;
  };
  const enrich = (key: string, row: any, include: any) => {
    if (!row) return null;
    if (key === 'products' && include) return { ...row, baseUnit: data.units.find(u => u.id === row.baseUnitId), category: data.categories.find(c => c.id === row.categoryId) ?? null, presentations: data.presentations.filter(p => p.productId === row.id).map(p => ({ ...p, unit: data.units.find(u => u.id === p.unitId) })) };
    return row;
  };
  const model = (key: keyof typeof data) => ({
    findMany: jest.fn(async ({ where, skip = 0, take = 999999 } = {} as any) => data[key].filter(row => queryMatch(row, where)).slice(skip, skip + take)),
    findUnique: jest.fn(async ({ where, include }: any) => enrich(key, data[key].find(row => queryMatch(row, where)), include)),
    count: jest.fn(async ({ where } = {} as any) => data[key].filter(row => queryMatch(row, where)).length),
    create: jest.fn(async ({ data: input }: any) => {
      if (key === 'presentations' && input.barcode && data.presentations.some(p => p.barcode === input.barcode)) throw { code: 'P2002' };
      if (key === 'operations' && data.operations.some(o => o.requestKey === input.requestKey)) throw { code: 'P2002' };
      if (key === 'categories' && data.categories.some(c => c.name.toLowerCase() === input.name.toLowerCase())) throw { code: 'P2002' };
      const row = { id: data[key].length + 1, version: 0, isActive: true, isSaleEnabled: false, isPurchase: false, salePrice: null, ...input };
      (data[key] as any[]).push(row); return row;
    }),
    update: jest.fn(async ({ where, data: update }: any) => patch(data[key].find(row => queryMatch(row, where)), update)),
  });
  const db: any = {
    materialUnit: model('units'), materialCategory: model('categories'), materialProduct: model('products'), materialPresentation: model('presentations'),
    materialStock: model('stocks'), materialOperation: model('operations'), materialMovement: model('movements'),
    materialSaleLine: model('lines'), warehouseStore: model('stores'),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, id: number) => {
      const table = strings.join('').includes('material_products') ? 'products' : 'stores'; locks.push(`${table}:${id}`);
      return data[table].filter(row => row.id === id).map(row => ({ id: row.id }));
    }),
    $transaction: async (work: any) => {
      const snapshot = JSON.parse(JSON.stringify(data));
      try { return await work(db); } catch (error) { data = snapshot; throw error; }
    },
  };
  db.materialStock.upsert = jest.fn(async ({ where, create, update }: any) => {
    const found = data.stocks.find(row => queryMatch(row, where.presentationId_storeId));
    if (found) return patch(found, update);
    const row = { id: data.stocks.length + 1, version: 0, ...create }; data.stocks.push(row); return row;
  });
  const service = new MaterialsInventoryService(db);
  const product = () => service.createProduct({ ...request(), name: 'Caulking', baseUnitId: 1, purchaseUnitId: 2, purchaseMultiplier: 20 }, admin);
  return { db, service, locks, product, get data() { return data; } };
}

describe('Materials inventory service', () => {
  it('maintains categories idempotently and keeps optional catalog fields independent of stock', async () => {
    const f = fixture();
    const categoryRequest = { ...request(), name: ' Sealants ' };
    const category = await f.service.createCategory(categoryRequest, admin);
    expect(category.name).toBe('Sealants');
    expect((await f.service.createCategory(categoryRequest, admin)).replayed).toBe(true);
    await expect(f.service.createCategory({ ...request(), name: 'sealants' }, admin)).rejects.toThrow('already exists');
    await expect(f.service.createCategory({ ...request(), name: 'Other' }, operator)).rejects.toThrow('authorized staff');
    const product = await f.service.createProduct({ ...request(), name: 'Caulking', baseUnitId: 1, purchaseUnitId: 2, purchaseMultiplier: 12, categoryId: category.id, brand: ' Sherwin-Williams ', imageUrl: null }, admin);
    expect(product).toMatchObject({ brand: 'Sherwin-Williams', imageUrl: null, category: { id: category.id, name: 'Sealants' }, totalBaseQuantity: 0 });
    await f.service.updateCategory(category.id, { ...request(), isActive: false }, admin);
    await expect(f.service.createProduct({ ...request(), name: 'Another', baseUnitId: 1, purchaseUnitId: 2, purchaseMultiplier: 12, categoryId: category.id }, admin)).rejects.toThrow('active material category');
    const updated = await f.service.updateProduct(product.id, { ...request(), version: product.version, categoryId: null, brand: null }, admin);
    expect(updated).toMatchObject({ brand: null, categoryId: null, category: null, totalBaseQuantity: 0 });
    expect((await f.service.categories(operator))[0].isActive).toBe(false);
  });

  it('refuses arbitrary image URLs and unregistered local paths before modifying a product', async () => {
    const f = fixture(); const product = await f.product();
    for (const imageUrl of ['https://example.test/image.png', '/uploads/unknown.png', '/api/materials/images/../.env', `/api/materials/images/${'b'.repeat(64)}.png`]) {
      await expect(f.service.updateProduct(product.id, { ...request(), version: product.version, imageUrl }, admin)).rejects.toThrow();
    }
    expect((await f.service.product(product.id, admin)).version).toBe(0);
  });

  it('creates manual-only product with zero stock and receives fixed boxes with per-purchase costs', async () => {
    const f = fixture(); const product = await f.product();
    expect(product.totalBaseQuantity).toBe(0);
    expect(product.isSaleEnabled).toBe(false);
    expect(product.presentations.map(p => p.barcode)).toEqual([null, null]);
    const receipt = await f.service.receive({ ...request(), productId: product.id, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, operator);
    expect(receipt.product.totalBaseQuantity).toBe(60);
    expect(receipt.product.presentations[1].quantity).toBe(3);
    expect(receipt.movement.totalCost).toBe('240');
    expect(f.locks.slice(-2)).toEqual(['products:1', 'stores:1']);
  });

  it('uses the same automatic opening for internal use and records who received the material', async () => {
    const f = fixture(); await f.product();
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    const result = await f.service.internalUse({ ...request(), productId: 1, presentationId: 1, storeId: 1, quantity: 4, recipient: 'Installer', note: 'Job A' }, operator);
    expect(result.product.presentations.map(p => p.quantity)).toEqual([16, 2]);
    expect((result.movement.details as any).opened).toEqual([{ presentationId: 2, quantity: 1, baseUnits: 20 }]);
    expect(result.movement.recipient).toBe('Installer');
    expect(result.movement.deltaBaseUnits).toBe(-4);
  });

  it('replays a receipt after an uncertain response and rejects reuse with changed quantities', async () => {
    const f = fixture(); await f.product();
    const dto = { ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 };
    await f.service.receive(dto, admin);
    expect((await f.service.receive(dto, admin)).replayed).toBe(true);
    expect(f.data.movements).toHaveLength(1);
    expect(f.data.stocks[0].quantity).toBe(3);
    await expect(f.service.receive({ ...dto, quantity: 4 }, admin)).rejects.toThrow('already used');
  });

  it('protects reservations across both full-box and individual-unit sales', async () => {
    const f = fixture(); await f.product();
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    f.data.lines.push({ productId: 1, presentationId: 2, quantity: 2, storeId: 1, saleId: 1, sale: { status: 'CONFIRMED' } });
    await expect(f.service.internalUse({ ...request(), productId: 1, presentationId: 1, storeId: 1, quantity: 21, recipient: 'Installer', note: 'Job A' }, operator)).rejects.toThrow('Insufficient');
    f.data.lines[0] = { productId: 1, presentationId: 1, quantity: 41, storeId: 1, saleId: 1, sale: { status: 'CONFIRMED' } };
    await expect(f.service.internalUse({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, recipient: 'Installer', note: 'Job A' }, operator)).rejects.toThrow('Insufficient');
    expect(f.data.stocks[0].quantity).toBe(3);
  });

  it('transfers loose units by opening a source box without changing the global quantity', async () => {
    const f = fixture(); await f.product();
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    const result = await f.service.transfer({ ...request(), productId: 1, presentationId: 1, fromStoreId: 1, toStoreId: 2, quantity: 4 }, operator);
    expect(result.product.totalBaseQuantity).toBe(60);
    expect(result.product.inventoryByStore.map(s => s.totalBaseQuantity)).toEqual([56, 4]);
    expect(result.movements.map(m => m.deltaBaseUnits)).toEqual([-4, 4]);
  });

  it('prepares bags from loose units while preserving the product total', async () => {
    const f = fixture(); await f.product();
    await f.service.createPresentation(1, { ...request(), unitId: 3, multiplier: 5 }, admin);
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    await f.service.repack({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, action: 'OPEN' }, operator);
    const result = await f.service.repack({ ...request(), productId: 1, presentationId: 3, storeId: 1, quantity: 4, action: 'PACK' }, operator);
    expect(result.product.presentations.map(p => p.quantity)).toEqual([0, 2, 4]);
    expect(result.product.totalBaseQuantity).toBe(60);
    expect(result.movement.deltaBaseUnits).toBe(0);
  });

  it('requires fresh counts and admin access for inventory adjustments', async () => {
    const f = fixture(); await f.product();
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    const dto = { ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 2, version: 0, note: 'Physical count' };
    await expect(f.service.adjust(dto, operator)).rejects.toThrow('authorized');
    await expect(f.service.adjust(dto, admin)).rejects.toThrow('Stock changed');
    const result = await f.service.adjust({ ...dto, version: 1 }, admin);
    expect(result.product.totalBaseQuantity).toBe(40);
  });

  it('only creates barcodes on explicit request and preserves manufacturer leading zeroes', async () => {
    const f = fixture(); await f.product();
    const updated = await f.service.updatePresentation(1, { ...request(), version: 0, barcode: '0012345678' }, admin);
    expect(updated.presentations[0].barcode).toBe('0012345678');
    expect((await f.service.findBarcode('0012345678', operator)).presentation.id).toBe(1);
    const generated = await f.service.updatePresentation(2, { ...request(), version: 0, generateBarcode: true }, admin);
    expect(generated.presentations[1].barcode).toMatch(/^MAT-[A-F0-9]{20}$/);
  });

  it('delivers its own mixed reservation, leaves other sales protected and opens only required boxes', async () => {
    const f = fixture(); await f.product();
    await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 80 }, admin);
    const lines = [{ productId: 1, presentationId: 1, quantity: 4, storeId: 1 }, { productId: 1, presentationId: 2, quantity: 1, storeId: 1 }];
    f.data.lines.push(...lines.map(l => ({ ...l, saleId: 1, sale: { status: 'CONFIRMED' } })), { productId: 1, presentationId: 1, quantity: 15, storeId: 1, saleId: 2, sale: { status: 'CONFIRMED' } });
    const key = randomUUID();
    await f.service.operation(key, {}, admin.id, 'DELIVER', async tx => ({ movements: await f.service.deliverSale(tx, { id: 1, lines }, key, admin.id) }));
    const state = await f.service.loadStock(f.db, 1, 1, 1);
    expect(state.packs.map(p => p.quantity)).toEqual([16, 1]);
    expect(state.reservations).toHaveLength(1);
    expect(f.data.movements.filter(m => m.kind === 'SALE_DELIVERY').map(m => m.deltaBaseUnits)).toEqual([-20, -4]);
  });

  it('does not accept receipts in disabled stores or quantities that overflow the movement ledger', async () => {
    const f = fixture(); await f.product();
    f.data.stores[0].isActive = false;
    await expect(f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, costPerPackage: 80 }, admin)).rejects.toThrow('inactive');
    f.data.stores[0].isActive = true;
    f.data.presentations[1].multiplier = 1000000;
    await expect(f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1000000, costPerPackage: 80 }, admin)).rejects.toThrow('supported limit');
    expect(f.data.stocks).toHaveLength(0);
  });
});

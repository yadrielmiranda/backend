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
  const sequences = new Map<string, number>();
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
      const id = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, id);
      const row = { id, version: 0, isActive: true, isBase: false, allowBaseUnitOperations: true, isSaleEnabled: false, isPurchase: false, salePrice: null, ...input };
      (data[key] as any[]).push(row); return row;
    }),
    update: jest.fn(async ({ where, data: update }: any) => patch(data[key].find(row => queryMatch(row, where)), update)),
    delete: jest.fn(async ({ where }: any) => {
      const index = data[key].findIndex(row => queryMatch(row, where));
      if (index < 0) throw { code: 'P2025' };
      return data[key].splice(index, 1)[0];
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const rows = data[key] as any[];
      const remaining = rows.filter(row => !queryMatch(row, where));
      const count = rows.length - remaining.length;
      rows.splice(0, rows.length, ...remaining);
      return { count };
    }),
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
  describe('complete-package daily operations', () => {
    const createRestricted = (f: ReturnType<typeof fixture>) => f.service.createProduct({
      ...request(), name: 'Screws', baseUnitId: 1, purchaseUnitId: 2, purchaseMultiplier: 1000, allowBaseUnitOperations: false,
    }, admin);

    it('defaults existing workflows to allowed and requires a real package for a restricted new product', async () => {
      const f = fixture();
      expect((await f.product()).allowBaseUnitOperations).toBe(true);
      await expect(f.service.createProduct({ ...request(), name: 'Screws', baseUnitId: 1, purchaseUnitId: 1,
        purchaseMultiplier: 1, allowBaseUnitOperations: false }, admin)).rejects.toThrow('more than one');
      expect(f.data.products).toHaveLength(1);
    });

    it.each([1, 3])('blocks base or 1x-alias presentation %i in receipts, issues and transfers without writes', async presentationId => {
      const f = fixture(); await createRestricted(f);
      await f.service.createPresentation(1, { ...request(), unitId: 3, multiplier: 1 }, admin);
      f.data.presentations.find(p => p.id === presentationId).isPurchase = true;
      const common = { productId: 1, presentationId, storeId: 1, quantity: 1000 };
      await expect(f.service.receive({ ...request(), ...common, costPerPackage: 1 }, admin)).rejects.toThrow('complete packages only');
      await expect(f.service.internalUse({ ...request(), ...common, recipient: 'Crew', note: 'Job' }, operator)).rejects.toThrow('complete packages only');
      await expect(f.service.transfer({ ...request(), ...common, fromStoreId: 1, toStoreId: 2 }, operator)).rejects.toThrow('complete packages only');
      expect(f.data.stocks).toHaveLength(0);
      expect(f.data.movements).toHaveLength(0);
    });

    it('receives, repacks, issues and transfers whole packages while leaving authorized base adjustments available', async () => {
      const f = fixture(); await createRestricted(f);
      await f.service.createPresentation(1, { ...request(), unitId: 3, multiplier: 100 }, admin);
      await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 3, costPerPackage: 25 }, operator);
      const opened = await f.service.repack({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, action: 'OPEN' }, operator);
      expect(opened.product.totalBaseQuantity).toBe(3000);
      const adjusted = await f.service.adjust({ ...request(), productId: 1, presentationId: 1, storeId: 1, quantity: 997,
        version: opened.product.version, note: 'Three damaged screws' }, admin);
      expect(adjusted.product.totalBaseQuantity).toBe(2997);
      const packed = await f.service.repack({ ...request(), productId: 1, presentationId: 3, storeId: 1, quantity: 9, action: 'PACK' }, operator);
      expect(packed.product.presentations.map(p => p.quantity)).toEqual([97, 2, 9]);
      await f.service.internalUse({ ...request(), productId: 1, presentationId: 3, storeId: 1, quantity: 2, recipient: 'Crew', note: 'Job' }, operator);
      const moved = await f.service.transfer({ ...request(), productId: 1, presentationId: 2, fromStoreId: 1, toStoreId: 2, quantity: 1 }, operator);
      expect(moved.product.totalBaseQuantity).toBe(2797);
      expect(moved.product.inventoryByStore.map(store => store.totalBaseQuantity)).toEqual([1797, 1000]);
    });

    it('rejects restricting a product with confirmed single-unit sales, but allows package reservations and canceled singles', async () => {
      const f = fixture(); const product = await f.product();
      f.data.lines.push({ productId: 1, presentationId: 1, multiplier: 1, sale: { status: 'CONFIRMED' } });
      await expect(f.service.updateProduct(1, { ...request(), version: product.version, allowBaseUnitOperations: false }, admin)).rejects.toThrow('confirmed sales of single units');
      expect(f.data.products[0].allowBaseUnitOperations).toBe(true);
      f.data.lines[0].sale.status = 'CANCELED';
      f.data.lines.push({ productId: 1, presentationId: 2, multiplier: 20, quantity: 1, storeId: 1, sale: { status: 'CONFIRMED' } });
      f.data.stocks.push({ productId: 1, presentationId: 2, storeId: 1, quantity: 1 });
      const restricted = await f.service.updateProduct(1, { ...request(), version: product.version, allowBaseUnitOperations: false }, admin);
      expect(restricted.allowBaseUnitOperations).toBe(false);
    });

    it('requires an active package and protects the last active package from deactivation or deletion', async () => {
      const f = fixture(); const product = await createRestricted(f);
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('at least one active package');
      await expect(f.service.updatePresentation(2, { ...request(), version: 0, isActive: false }, admin)).rejects.toThrow('at least one active package');
      await f.service.updateProduct(1, { ...request(), version: product.version, allowBaseUnitOperations: true }, admin);
      await f.service.deletePresentation(2, { ...request(), version: 0 }, admin);
      const current = await f.service.product(1, admin);
      await expect(f.service.updateProduct(1, { ...request(), version: current.version, allowBaseUnitOperations: false }, admin)).rejects.toThrow('active package');
    });

    it('allows replacing the purchase package and prevents enabling a single-unit sale or purchase under restriction', async () => {
      const f = fixture(); await createRestricted(f);
      await f.service.createPresentation(1, { ...request(), unitId: 3, multiplier: 100, isPurchase: true }, admin);
      await f.service.deletePresentation(2, { ...request(), version: 0 }, admin);
      await expect(f.service.updatePresentation(1, { ...request(), version: 0, isPurchase: true }, admin)).rejects.toThrow('complete packages only');
      await expect(f.service.updatePresentation(1, { ...request(), version: 0, isSaleEnabled: true, salePrice: 1 }, admin)).rejects.toThrow('complete packages only');
      await expect(f.service.createPresentation(1, { ...request(), unitId: 2, multiplier: 1, isPurchase: true }, admin)).rejects.toThrow('complete packages only');
      expect(f.data.presentations.map(p => p.id)).toEqual([1, 3]);
    });

    it('checks the live package policy during delivery before changing stock', async () => {
      const f = fixture(); await createRestricted(f);
      await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, costPerPackage: 25 }, operator);
      const lines = [{ productId: 1, presentationId: 1, storeId: 1, quantity: 1 }];
      const key = randomUUID();
      await expect(f.service.operation(key, {}, admin.id, 'DELIVER', async tx => ({
        movements: await f.service.deliverSale(tx, { id: 1, lines }, key, admin.id),
      }))).rejects.toThrow('complete packages only');
      expect(f.data.stocks[0].quantity).toBe(1);
      expect(f.data.movements).toHaveLength(1);
    });
  });

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

  describe('deleting unused presentations', () => {
    it('removes an unused presentation, preserves its audit and safely replays a retry', async () => {
      const f = fixture(); await f.product();
      const dto = { ...request(), version: 0 };
      const result = await f.service.deletePresentation(2, dto, admin);
      expect(result).toMatchObject({ id: 2, productId: 1, replayed: false, deletedPresentation: { id: 2, multiplier: 20 } });
      expect(f.data.presentations.map(p => p.id)).toEqual([1]);
      expect(f.data.products[0].version).toBe(1);
      expect(f.data.movements).toHaveLength(0);
      expect(f.locks.at(-1)).toBe('products:1');
      expect(f.data.operations.find(op => op.requestKey === dto.requestKey)).toMatchObject({ kind: 'DELETE_PRESENTATION', actorId: 1, result: { deletedPresentation: { id: 2 } } });
      expect((await f.service.deletePresentation(2, dto, admin)).replayed).toBe(true);
      expect(f.db.materialPresentation.delete).toHaveBeenCalledTimes(1);
      expect(f.data.products[0].version).toBe(1);
      await expect(f.service.deletePresentation(1, dto, admin)).rejects.toThrow('already used');
      await expect(f.service.deletePresentation(2, { ...dto, version: 1 }, admin)).rejects.toThrow('already used');
      await expect(f.service.deletePresentation(2, dto, { ...admin, id: 3 })).rejects.toThrow('already used');
    });

    it('allows an unused inactive presentation and removes only its empty stock rows', async () => {
      const f = fixture(); await f.product();
      f.data.presentations[1].isActive = false;
      f.data.stocks.push({ presentationId: 2, productId: 1, storeId: 1, quantity: 0 }, { presentationId: 2, productId: 1, storeId: 2, quantity: 0 }, { presentationId: 1, productId: 1, storeId: 2, quantity: 5 });
      await f.service.deletePresentation(2, { ...request(), version: 0 }, admin);
      expect(f.data.stocks).toEqual([{ presentationId: 1, productId: 1, storeId: 2, quantity: 5 }]);
    });

    it.each(['operator', 'dealer', 'client'])('rejects %s without modifying the catalog', async role => {
      const f = fixture(); await f.product();
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, { id: 7, role: { name: role } } as any)).rejects.toThrow('authorized staff');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it('keeps the base presentation even when all stock is zero', async () => {
      const f = fixture(); await f.product();
      await expect(f.service.deletePresentation(1, { ...request(), version: 0 }, admin)).rejects.toThrow('base presentation');
      expect(f.data.presentations).toHaveLength(2);
      expect(f.data.products[0].version).toBe(0);
    });

    it.each([1, -1])('blocks nonzero stock (%i) even in an inactive store', async quantity => {
      const f = fixture(); await f.product();
      f.data.stores[1].isActive = false;
      f.data.stocks.push({ productId: 1, presentationId: 2, storeId: 2, quantity });
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('has inventory');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it('keeps a presentation with receipt and withdrawal history after its balance returns to zero', async () => {
      const f = fixture(); await f.product();
      await f.service.receive({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, costPerPackage: 80 }, admin);
      await f.service.internalUse({ ...request(), productId: 1, presentationId: 2, storeId: 1, quantity: 1, recipient: 'Installer', note: 'Job' }, operator);
      expect(f.data.stocks[0].quantity).toBe(0);
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('inventory movements');
      expect(f.data.movements).toHaveLength(2);
      expect(f.data.stocks).toHaveLength(1);
    });

    it.each(['changes', 'opened', 'countedPresentations'])('protects movement references stored only in %s details', async field => {
      const f = fixture(); await f.product();
      f.data.movements.push({ id: 1, productId: 1, presentationId: 1, details: { [field]: [{ presentationId: 2, quantity: 0 }] } });
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('inventory movements');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it('finds references beyond the first batch without mistaking other IDs for this presentation', async () => {
      const f = fixture(); await f.product();
      f.data.movements.push(...Array.from({ length: 200 }, (_, i) => ({ id: i + 1, productId: 1, presentationId: 1, details: { changes: [{ presentationId: 22, before: 0, after: 2 }] } })));
      f.data.movements.push({ id: 201, productId: 1, presentationId: 1, details: { nested: { changes: [{ presentationId: 2 }] } } });
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('inventory movements');
      expect(f.db.materialMovement.findMany).toHaveBeenCalledTimes(2);
    });

    it('allows unused presentations even when other presentations of the product have history', async () => {
      const f = fixture(); await f.product();
      f.data.movements.push({ id: 1, productId: 1, presentationId: 1, details: { changes: [{ presentationId: 1, after: 2 }], note: 'presentationId: 2' } });
      await f.service.deletePresentation(2, { ...request(), version: 0 }, admin);
      expect(f.data.movements).toHaveLength(1);
      expect(f.data.presentations.map(p => p.id)).toEqual([1]);
    });

    it.each(['DRAFT', 'CONFIRMED', 'CANCELED', 'DELIVERED'])('preserves references from %s sales', async status => {
      const f = fixture(); await f.product();
      f.data.lines.push({ presentationId: 2, productId: 1, quantity: 1, sale: { status } });
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('linked to a sale');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it('rejects stale versions and missing presentations', async () => {
      const f = fixture(); await f.product();
      await f.service.updatePresentation(2, { ...request(), version: 0, name: 'Renamed' }, admin);
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('changed');
      await expect(f.service.deletePresentation(999, { ...request(), version: 0 }, admin)).rejects.toThrow('not found');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it('rechecks stock under the product lock before deleting', async () => {
      const f = fixture(); await f.product();
      const lock = f.service.lockProducts.bind(f.service);
      jest.spyOn(f.service, 'lockProducts').mockImplementationOnce(async (tx, ids) => {
        await lock(tx, ids);
        f.data.stocks.push({ productId: 1, presentationId: 2, storeId: 1, quantity: 1 });
      });
      await expect(f.service.deletePresentation(2, { ...request(), version: 0 }, admin)).rejects.toThrow('has inventory');
      expect(f.db.materialPresentation.delete).not.toHaveBeenCalled();
    });

    it.each(['delete', 'update'])('returns not found when a presentation disappears before the %s lock is acquired', async action => {
      const f = fixture(); await f.product();
      const lock = f.service.lockProducts.bind(f.service);
      jest.spyOn(f.service, 'lockProducts').mockImplementationOnce(async (tx, ids) => {
        await lock(tx, ids);
        f.data.presentations.splice(1, 1);
      });
      const promise = action === 'delete'
        ? f.service.deletePresentation(2, { ...request(), version: 0 }, admin)
        : f.service.updatePresentation(2, { ...request(), version: 0, name: 'New name' }, admin);
      await expect(promise).rejects.toThrow('not found');
    });

    it('rolls back empty-stock cleanup and audit on a restrictive foreign-key conflict', async () => {
      const f = fixture(); await f.product();
      f.data.stocks.push({ productId: 1, presentationId: 2, storeId: 1, quantity: 0 });
      f.db.materialPresentation.delete.mockRejectedValueOnce({ code: 'P2003' });
      const dto = { ...request(), version: 0 };
      await expect(f.service.deletePresentation(2, dto, admin)).rejects.toThrow('in use');
      expect(f.data.stocks).toHaveLength(1);
      expect(f.data.presentations).toHaveLength(2);
      expect(f.data.products[0].version).toBe(0);
      expect(f.data.operations.some(op => op.requestKey === dto.requestKey)).toBe(false);
    });
  });
});

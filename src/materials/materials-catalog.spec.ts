import { Prisma } from '@prisma/client';
import { materialCatalogAvailability, materialCatalogPage, parseMaterialCatalogQuery } from './materials-catalog';

function fixture(count = 200) {
  const categories = [{ id: 1, name: 'Sealants', isActive: true }, { id: 2, name: 'Fasteners', isActive: true }, { id: 3, name: 'Old', isActive: false }];
  const products = Array.from({ length: count }, (_, i) => ({
    id: i + 1, name: `Material ${String(i + 1).padStart(3, '0')}`, code: `MAT-${i + 1}`, description: i === 199 ? 'Special outdoor adhesive' : 'A material',
    brand: i % 2 ? 'Beta' : 'Alpha', categoryId: i % 2 + 1, category: categories[i % 2], imageUrl: `/api/materials/images/${'a'.repeat(64)}.png`,
    baseUnit: { id: 1, name: 'Tube' }, isActive: true, isSaleEnabled: true,
    presentations: [
      { id: i * 2 + 1, productId: i + 1, name: 'Tube', multiplier: 1, isBase: true, isActive: true, isSaleEnabled: true, salePrice: new Prisma.Decimal(15), barcode: null, unit: { id: 1, name: 'Tube' } },
      { id: i * 2 + 2, productId: i + 1, name: 'Box of 12', multiplier: 12, isBase: false, isActive: true, isSaleEnabled: true, salePrice: new Prisma.Decimal(120), barcode: null, unit: { id: 2, name: 'Box' } },
    ],
  }));
  const stock: any[] = products.flatMap(product => [1, 2].map(storeId => ({ productId: product.id, storeId, presentationId: product.presentations[1].id, quantity: 1, store: { isActive: true } })));
  const reservations: any[] = [];
  function matches(row: any, where: any = {}) {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (value === undefined) return true;
      if (key === 'OR') return value.some((clause: any) => matches(row, clause));
      if (value !== null && typeof value === 'object') {
        if ('some' in value) return (row[key] ?? []).some((entry: any) => matches(entry, value.some));
        if ('in' in value) return value.in.includes(row[key]);
        if ('not' in value) return row[key] !== value.not;
        if ('gt' in value) return Number(row[key]) > Number(value.gt);
        if ('contains' in value) return String(row[key] ?? '').toLowerCase().includes(String(value.contains).toLowerCase());
        return matches(row[key] ?? {}, value);
      }
      return row[key] === value;
    });
  }
  function project(row: any, select: any) {
    if (!select) return row;
    return Object.fromEntries(Object.entries(select).map(([key, value]: [string, any]) => [key,
      value === true ? row[key] : Array.isArray(row[key]) ? row[key].filter(entry => matches(entry, value.where)).map(entry => project(entry, value.select)) : project(row[key], value.select),
    ]));
  }
  function find(rows: any[], args: any = {}) {
    let result = rows.filter(row => matches(row, args.where));
    if (args.orderBy) {
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      result.sort((a, b) => {
        for (const order of orders) for (const [key, direction] of Object.entries(order)) {
          const comparison = typeof a[key] === 'number' ? a[key] - b[key] : String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
          if (comparison) return direction === 'desc' ? -comparison : comparison;
        }
        return 0;
      });
    }
    if (args.distinct) result = result.filter((row, i) => result.findIndex(other => args.distinct.every((key: string) => row[key] === other[key])) === i);
    return result.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? result.length)).map(row => project(row, args.select));
  }
  const db: any = {
    materialProduct: { count: jest.fn(async ({ where }) => products.filter(row => matches(row, where)).length), findMany: jest.fn(async (args: any) => find(products, args)) },
    materialCategory: { findMany: jest.fn(async (args: any) => find(categories.map(category => ({ ...category, products: products.filter(product => product.categoryId === category.id) })), args)) },
    materialPresentation: { findMany: jest.fn(async (args: any) => find(products.flatMap(product => product.presentations), args)) },
    materialStock: { findMany: jest.fn(async (args: any) => find(stock, args)) },
    materialSaleLine: { findMany: jest.fn(async (args: any) => find(reservations, args)) },
  };
  return { db, products, stock, reservations, categories };
}

describe('Paged materials catalog', () => {
  it('serves 200 products across nine database pages with metadata only for the requested 24', async () => {
    const f = fixture();
    const first = await materialCatalogPage(f.db);
    const last = await materialCatalogPage(f.db, { page: '9' });
    expect(first).toMatchObject({ total: 200, page: 1, pageSize: 24, brands: ['Alpha', 'Beta'] });
    expect(first.products.map(p => p.id)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(last.products.map(p => p.id)).toEqual([193, 194, 195, 196, 197, 198, 199, 200]);
    const fullReads = f.db.materialProduct.findMany.mock.calls.filter(([args]) => args.select.imageUrl);
    expect(fullReads.map(([args]) => [args.skip, args.take])).toEqual([[0, 24], [192, 24]]);
    expect(f.db.materialPresentation.findMany).toHaveBeenCalledTimes(2);
    expect(f.db.materialStock.findMany).toHaveBeenCalledTimes(2);
    expect(f.db.materialSaleLine.findMany).toHaveBeenCalledTimes(2);
    expect(first.products[0].presentations[1]).toMatchObject({ unit: { id: 2, name: 'Box' }, salePrice: '120.00', availableQuantity: 2 });
  });

  it('filters category, brand and description on the backend with stable ordering', async () => {
    const f = fixture();
    expect((await materialCatalogPage(f.db, { categoryId: '2', brand: 'Beta', sort: 'name-desc', pageSize: '3' })).products.map(p => p.id)).toEqual([200, 198, 196]);
    expect((await materialCatalogPage(f.db, { q: 'outdoor' })).products.map(p => p.id)).toEqual([200]);
    expect((await materialCatalogPage(f.db, { q: 'MAT-199' })).products.map(p => p.id)).toEqual([199]);
    expect((await materialCatalogPage(f.db, { q: 'alpha', pageSize: '100' })).total).toBe(100);
    f.products[0].name = f.products[2].name;
    expect((await materialCatalogPage(f.db, { categoryId: '1', pageSize: '2' })).products.map(p => p.id)).toEqual([1, 3]);
  });

  it('filters exact availability before counting and paging without fetching every product image', async () => {
    const f = fixture();
    f.stock.forEach(row => { if (row.productId <= 30) row.quantity = 0; });
    // The only sale format for #31 is a box; 24 loose tubes across stores cannot fulfill it.
    f.products[30].presentations[0].isSaleEnabled = false;
    f.stock.filter(row => row.productId === 31).forEach(row => { row.presentationId = 61; row.quantity = 12; });
    const result = await materialCatalogPage(f.db, { inStock: 'true' });
    expect(result.total).toBe(169);
    expect(result.products.map(p => p.id)).toEqual(Array.from({ length: 24 }, (_, i) => i + 32));
    expect(f.db.materialProduct.findMany.mock.calls.filter(([args]) => args.select.imageUrl)).toHaveLength(1);
    expect(f.db.materialStock.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.materialSaleLine.findMany).toHaveBeenCalledTimes(1);
  });

  it('preserves whole boxes and loose reservations separately within each active store', async () => {
    const f = fixture(1);
    f.reservations.push({ productId: 1, storeId: 1, presentationId: 1, quantity: 1, sale: { status: 'CONFIRMED' }, store: { isActive: true } });
    f.stock.push({ productId: 1, storeId: 3, presentationId: 2, quantity: 50, store: { isActive: false } });
    const result = await materialCatalogAvailability(f.db, [1]);
    expect(result.quantities.get(1)).toBe(23);
    expect(result.quantities.get(2)).toBe(1);
    f.reservations.push({ productId: 1, storeId: 2, presentationId: 2, quantity: 1, sale: { status: 'CONFIRMED' }, store: { isActive: true } });
    const reserved = await materialCatalogPage(f.db);
    expect(reserved.products[0].presentations.map(p => p.availableQuantity)).toEqual([11, 0]);
  });

  it('includes units in non-sale boxes and omits inactive products and unavailable formats', async () => {
    const f = fixture(4);
    f.products[0].presentations[1].isSaleEnabled = false;
    f.products[1].isActive = false;
    f.products[2].isSaleEnabled = false;
    f.products[3].presentations.forEach(p => { p.isSaleEnabled = false; });
    const result = await materialCatalogPage(f.db);
    expect(result.total).toBe(1);
    expect(result.products[0].presentations).toHaveLength(1);
    expect(result.products[0].presentations[0].availableQuantity).toBe(24);
  });

  it('refreshes only cart IDs independently of the current page and filters', async () => {
    const f = fixture();
    const result = await materialCatalogPage(f.db, { presentationIds: '1,400', page: '9', q: 'missing', categoryId: '999', brand: 'missing', inStock: 'true' });
    expect(result.products.flatMap(p => p.presentations.map(item => item.id))).toEqual([1, 400]);
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 100 });
    expect(f.db.materialPresentation.findMany.mock.calls[0][0].where.productId.in).toEqual([1, 200]);
  });

  it('caps page size and rejects malformed or unbounded cart and filter input', () => {
    expect(parseMaterialCatalogQuery({ pageSize: '500' }).pageSize).toBe(100);
    for (const query of [{ page: '0' }, { page: '1.5' }, { categoryId: '-1' }, { inStock: 'yes' }, { sort: 'SQL' }, { q: 'a'.repeat(201) }, { presentationIds: '1,../../a' }, { presentationIds: Array(101).fill('1').join(',') }, { q: ['a', 'b'] }]) {
      expect(() => parseMaterialCatalogQuery(query as any)).toThrow();
    }
  });
});

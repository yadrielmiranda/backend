import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { materialAvailability, MaterialReservation } from './materials-stock';
import { allowsMaterialDailyOperation } from './materials-operation-policy';

export type MaterialCatalogQuery = Record<string, string | undefined>;
const sellablePresentation = {
  isActive: true, isSaleEnabled: true, salePrice: { gt: 0 },
  OR: [{ product: { allowBaseUnitOperations: true } }, { isBase: false, multiplier: { gt: 1 } }],
} satisfies Prisma.MaterialPresentationWhereInput;
const visibleProduct = { isActive: true, isSaleEnabled: true, presentations: { some: sellablePresentation } } satisfies Prisma.MaterialProductWhereInput;

function optionalText(query: MaterialCatalogQuery, key: string, max: number) {
  const value = query[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`Invalid catalog ${key}.`);
  return value.trim() || undefined;
}
function integer(value: string | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BadRequestException(`Invalid catalog ${label}.`);
  return Number(value);
}
export function parseMaterialCatalogQuery(query: MaterialCatalogQuery = {}) {
  const q = optionalText(query, 'q', 200), brand = optionalText(query, 'brand', 120);
  const category = optionalText(query, 'categoryId', 12), inStock = optionalText(query, 'inStock', 5);
  const sort = optionalText(query, 'sort', 20) ?? 'name-asc';
  if (!['name-asc', 'name-desc'].includes(sort) || (inStock !== undefined && !['true', 'false'].includes(inStock)))
    throw new BadRequestException('Invalid catalog filters.');
  const ids = optionalText(query, 'presentationIds', 1200);
  const presentationIds = ids ? [...new Set(ids.split(',').map(id => integer(id, 0, 'presentation IDs')))] : undefined;
  if (presentationIds && (ids.split(',').length > 100 || presentationIds.some(id => id > 2147483647)))
    throw new BadRequestException('Refresh at most 100 cart items at a time.');
  const page = Math.min(100000, integer(optionalText(query, 'page', 12), 1, 'page'));
  const pageSize = Math.min(100, integer(optionalText(query, 'pageSize', 12), 24, 'page size'));
  const categoryId = category ? integer(category, 0, 'category') : undefined;
  if (categoryId > 2147483647) throw new BadRequestException('Invalid catalog category.');
  return { q, brand, categoryId, inStock: inStock === 'true', sort, page, pageSize, presentationIds };
}

/** Three batched reads, regardless of product/store counts. Include every package because
 * loose units can come from boxes that are not themselves enabled for sale. */
export async function materialCatalogAvailability(tx: Prisma.TransactionClient, productIds: number[]) {
  const quantities = new Map<number, number>(), inStock = new Set<number>();
  if (!productIds.length) return { quantities, inStock };
  const [presentations, stocks, reservations] = await Promise.all([
    tx.materialPresentation.findMany({ where: { productId: { in: productIds } }, select: {
      id: true, productId: true, multiplier: true, isBase: true, isActive: true, isSaleEnabled: true, salePrice: true,
      product: { select: { allowBaseUnitOperations: true } },
    } }),
    tx.materialStock.findMany({ where: { productId: { in: productIds }, store: { isActive: true } }, select: { productId: true, storeId: true, presentationId: true, quantity: true } }),
    tx.materialSaleLine.findMany({ where: { productId: { in: productIds }, store: { isActive: true }, sale: { status: 'CONFIRMED' } }, select: { productId: true, storeId: true, presentationId: true, quantity: true } }),
  ]);
  const packsByProduct = new Map<number, typeof presentations>();
  for (const presentation of presentations) {
    const packs = packsByProduct.get(presentation.productId) ?? [];
    packs.push(presentation); packsByProduct.set(presentation.productId, packs);
  }
  const groups = new Map<string, { productId: number; stocks: Map<number, number>; reservations: MaterialReservation[] }>();
  const group = (productId: number, storeId: number) => {
    const key = `${productId}:${storeId}`;
    if (!groups.has(key)) groups.set(key, { productId, stocks: new Map(), reservations: [] });
    return groups.get(key)!;
  };
  for (const stock of stocks) group(stock.productId, stock.storeId).stocks.set(stock.presentationId, stock.quantity);
  for (const reservation of reservations) group(reservation.productId, reservation.storeId).reservations.push(reservation);
  for (const location of groups.values()) {
    const packs = packsByProduct.get(location.productId) ?? [];
    const base = packs.find(pack => pack.isBase);
    if (!base) continue;
    const availability = materialAvailability({ basePresentationId: base.id,
      packs: packs.map(pack => ({ id: pack.id, baseUnits: pack.multiplier, quantity: location.stocks.get(pack.id) ?? 0 })),
      reservations: location.reservations,
    });
    for (const item of availability.presentations) quantities.set(item.id, (quantities.get(item.id) ?? 0) + item.availableQuantity);
  }
  for (const p of presentations) {
    if (p.isActive && p.isSaleEnabled && allowsMaterialDailyOperation(p.product, p) && Number(p.salePrice) > 0 && (quantities.get(p.id) ?? 0) > 0) inStock.add(p.productId);
  }
  return { quantities, inStock };
}

export async function materialCatalogPage(tx: Prisma.TransactionClient, query: MaterialCatalogQuery = {}) {
  const filters = parseMaterialCatalogQuery(query);
  const { presentationIds } = filters;
  // Cart refresh must find its IDs even when the shopper is on another page/category.
  let where: Prisma.MaterialProductWhereInput = presentationIds ? {
    ...visibleProduct, presentations: { some: { ...sellablePresentation, id: { in: presentationIds } } },
  } : {
    ...visibleProduct,
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.brand ? { brand: filters.brand } : {}),
    ...(filters.q ? { OR: ['name', 'code', 'description', 'brand'].map(field => ({ [field]: { contains: filters.q } })) } : {}),
  };
  let available: Awaited<ReturnType<typeof materialCatalogAvailability>>;
  if (!presentationIds && filters.inStock) {
    // Read only IDs and inventory for matching candidates, not all descriptions/photos.
    const candidates = await tx.materialProduct.findMany({ where, select: { id: true } });
    available = await materialCatalogAvailability(tx, candidates.map(product => product.id));
    where = { ...where, id: { in: [...available.inStock] } };
  }
  const page = presentationIds ? 1 : filters.page, pageSize = presentationIds ? 100 : filters.pageSize;
  const [total, products, categories, brandRows] = await Promise.all([
    tx.materialProduct.count({ where }),
    tx.materialProduct.findMany({ where, skip: (page - 1) * pageSize, take: pageSize,
      orderBy: [{ name: filters.sort === 'name-desc' ? 'desc' : 'asc' }, { id: 'asc' }],
      select: { id: true, code: true, name: true, description: true, imageUrl: true, brand: true, categoryId: true, allowBaseUnitOperations: true,
        category: { select: { id: true, name: true, isActive: true } }, baseUnit: { select: { id: true, name: true } },
        presentations: { where: { ...sellablePresentation, ...(presentationIds ? { id: { in: presentationIds } } : {}) },
          orderBy: [{ multiplier: 'asc' }, { id: 'asc' }], select: { id: true, name: true, multiplier: true, barcode: true, salePrice: true, unit: { select: { id: true, name: true } } },
        },
      },
    }),
    tx.materialCategory.findMany({ where: { isActive: true, products: { some: visibleProduct } }, select: { id: true, name: true, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    tx.materialProduct.findMany({ where: { ...visibleProduct, brand: { not: null } }, select: { brand: true }, distinct: ['brand'], orderBy: { brand: 'asc' } }),
  ]);
  available ??= await materialCatalogAvailability(tx, products.map(product => product.id));
  return {
    total, page, pageSize, categories, brands: brandRows.map(row => row.brand).filter(Boolean),
    products: products.map(product => ({ ...product, presentations: product.presentations.map(presentation => ({
      ...presentation, salePrice: presentation.salePrice.toFixed(2), availableQuantity: available.quantities.get(presentation.id) ?? 0,
    })) })),
  };
}

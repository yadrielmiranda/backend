import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialsInventoryService } from './materials-inventory.service';
import { MaterialStoreCountDto } from './materials-store-inventory.dto';
import { materialAvailability, MaterialStockError, MaterialStockState } from './materials-stock';

type Tx = Prisma.TransactionClient;
const productSelect = {
  id: true, code: true, name: true, imageUrl: true, isActive: true, version: true,
  baseUnit: { select: { id: true, name: true } },
} satisfies Prisma.MaterialProductSelect;
type Product = Prisma.MaterialProductGetPayload<{ select: typeof productSelect }>;
const presentationSelect = {
  id: true, productId: true, name: true, barcode: true, multiplier: true, isBase: true, isActive: true,
} satisfies Prisma.MaterialPresentationSelect;
type Presentation = Prisma.MaterialPresentationGetPayload<{ select: typeof presentationSelect }>;
type Stock = { productId: number; presentationId: number; quantity: number };
type Snapshot = {
  presentations: Map<number, Presentation[]>;
  quantities: Map<number, number>;
  reservations: Map<number, Stock[]>;
};
const integer = (value: unknown, min = 1, max = 2147483647): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

@Injectable()
export class MaterialsStoreInventoryService {
  constructor(private readonly prisma: PrismaService, private readonly inventory: MaterialsInventoryService) {}

  private storeId(id: number) {
    if (!integer(id)) throw new BadRequestException('Select a valid store.');
  }

  /** Fetch every product in one snapshot; physical counts must not silently stop at a catalog page. */
  async getInventory(storeId: number, actor: AuthUser) {
    this.inventory.staff(actor);
    this.storeId(storeId);
    try {
      return await this.prisma.$transaction(async tx => {
        const store = await tx.warehouseStore.findUnique({
          where: { id: storeId }, select: { id: true, name: true, isActive: true },
        });
        if (!store) throw new NotFoundException('Store not found.');
        const products = await tx.materialProduct.findMany({
          where: { OR: [
            { isActive: true },
            { stocks: { some: { storeId, quantity: { gt: 0 } } } },
            { saleLines: { some: { storeId, quantity: { gt: 0 }, sale: { status: 'CONFIRMED' } } } },
          ] },
          select: productSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const snapshot = await this.snapshot(tx, storeId, products.map(product => product.id));
        return { store, products: products.map(product => this.present(product, snapshot)) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    } catch (error) {
      if (error instanceof MaterialStockError) throw new ConflictException(error.message);
      throw error;
    }
  }

  private async snapshot(tx: Tx, storeId: number, productIds: number[]): Promise<Snapshot> {
    const snapshot: Snapshot = { presentations: new Map(), quantities: new Map(), reservations: new Map() };
    if (!productIds.length) return snapshot;
    const [presentations, stocks, reservations] = await Promise.all([
      tx.materialPresentation.findMany({ where: { productId: { in: productIds } }, select: presentationSelect, orderBy: { id: 'asc' } }),
      tx.materialStock.findMany({ where: { storeId, productId: { in: productIds } }, select: { productId: true, presentationId: true, quantity: true } }),
      tx.materialSaleLine.findMany({
        where: { storeId, productId: { in: productIds }, sale: { status: 'CONFIRMED' } },
        select: { productId: true, presentationId: true, quantity: true },
      }),
    ]);
    for (const presentation of presentations) {
      const group = snapshot.presentations.get(presentation.productId) ?? [];
      group.push(presentation);
      snapshot.presentations.set(presentation.productId, group);
    }
    for (const stock of stocks) snapshot.quantities.set(stock.presentationId, stock.quantity);
    for (const reservation of reservations) {
      const group = snapshot.reservations.get(reservation.productId) ?? [];
      group.push(reservation);
      snapshot.reservations.set(reservation.productId, group);
    }
    return snapshot;
  }

  private state(productId: number, snapshot: Snapshot): MaterialStockState {
    const presentations = snapshot.presentations.get(productId) ?? [];
    const base = presentations.find(presentation => presentation.isBase);
    if (!base) throw new ConflictException('A material is missing its base-unit presentation.');
    return {
      basePresentationId: base.id,
      packs: presentations.map(presentation => ({
        id: presentation.id, baseUnits: presentation.multiplier,
        quantity: snapshot.quantities.get(presentation.id) ?? 0,
      })),
      reservations: snapshot.reservations.get(productId) ?? [],
    };
  }

  private present(product: Product, snapshot: Snapshot) {
    const availability = materialAvailability(this.state(product.id, snapshot));
    const totals = new Map(availability.presentations.map(row => [row.id, row]));
    return {
      ...product,
      totalBaseQuantity: availability.totalBaseQuantity,
      reservedBaseQuantity: availability.reservedBaseQuantity,
      availableBaseQuantity: availability.availableBaseQuantity,
      presentations: (snapshot.presentations.get(product.id) ?? []).flatMap(presentation => {
        const quantity = totals.get(presentation.id)!;
        if (!presentation.isActive && !quantity.quantity && !quantity.reservedQuantity) return [];
        const { productId: _productId, ...fields } = presentation;
        return [{ ...fields, quantity: quantity.quantity, reservedQuantity: quantity.reservedQuantity, availableQuantity: quantity.availableQuantity }];
      }),
    };
  }

  private validate(dto: MaterialStoreCountDto) {
    if (!dto || typeof dto.requestKey !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(dto.requestKey))
      throw new BadRequestException('A valid count request is required.');
    if (typeof dto.note !== 'string' || !dto.note.trim() || dto.note.length > 1000)
      throw new BadRequestException('Enter a count reason, up to 1000 characters.');
    if (!Array.isArray(dto.products) || !dto.products.length || dto.products.length > 5000)
      throw new BadRequestException('Enter counts for between 1 and 5000 products.');
    const productIds = new Set<number>();
    const presentationIds = new Set<number>();
    for (const product of dto.products) {
      if (!product || !integer(product.productId) || productIds.has(product.productId))
        throw new BadRequestException('Each counted product must have a unique, valid ID.');
      productIds.add(product.productId);
      if (!integer(product.version, 0)) throw new BadRequestException('Reload the product before counting.');
      if (!Array.isArray(product.counts) || !product.counts.length || product.counts.length > 1000)
        throw new BadRequestException('Enter at least one presentation count for each selected product.');
      for (const count of product.counts) {
        if (!count || !integer(count.presentationId) || presentationIds.has(count.presentationId))
          throw new BadRequestException('Each counted presentation must have a unique, valid ID.');
        presentationIds.add(count.presentationId);
        if (!integer(count.quantity, 0, 1000000))
          throw new BadRequestException('Counted quantities must be whole numbers from 0 to 1,000,000.');
      }
    }
  }

  async count(storeId: number, dto: MaterialStoreCountDto, actor: AuthUser) {
    this.inventory.staff(actor, true);
    this.storeId(storeId);
    this.validate(dto);
    // Stable ordering makes the operation and its lock order independent of table sorting/filtering.
    const products = dto.products.map(product => ({ ...product, counts: [...product.counts].sort((a, b) => a.presentationId - b.presentationId) }))
      .sort((a, b) => a.productId - b.productId);
    const note = dto.note.trim();
    const result = await this.inventory.operation(dto.requestKey, { storeId, note, products }, actor.id, 'STORE_COUNT', async tx => {
      await this.inventory.lockProducts(tx, products.map(product => product.productId));
      await this.inventory.lockStores(tx, [storeId]);
      const store = await tx.warehouseStore.findUnique({ where: { id: storeId }, select: { id: true, name: true, isActive: true } });
      if (!store?.isActive) throw new ConflictException('This store is inactive.');
      const current = await tx.materialProduct.findMany({ where: { id: { in: products.map(product => product.productId) } }, select: productSelect });
      const byId = new Map(current.map(product => [product.id, product]));
      const snapshot = await this.snapshot(tx, storeId, products.map(product => product.productId));
      // Validate every final product state first. A box and loose-unit correction is one count,
      // so a valid redistribution must not fail against a temporary, half-applied state.
      const prepared = products.map(product => {
        const live = byId.get(product.productId);
        if (!live) throw new NotFoundException('Material product not found.');
        if (!live.isActive) throw new ConflictException(`${live.name} is inactive and cannot be counted.`);
        if (live.version !== product.version) throw new ConflictException(`Stock changed for ${live.name}. Reload and count again.`);
        const presentations = new Map((snapshot.presentations.get(product.productId) ?? []).map(presentation => [presentation.id, presentation]));
        for (const count of product.counts) {
          const presentation = presentations.get(count.presentationId);
          if (!presentation?.isActive) throw new BadRequestException('Select active presentations belonging to the counted product.');
        }
        const before = this.state(product.productId, snapshot);
        const counts = new Map(product.counts.map(count => [count.presentationId, count.quantity]));
        const after = { ...before, packs: before.packs.map(pack => ({ ...pack, quantity: counts.get(pack.id) ?? pack.quantity })) };
        const availability = materialAvailability(after);
        const changed = after.packs.some((pack, index) => pack.quantity !== before.packs[index].quantity);
        return { product, before, after, total: availability.totalBaseQuantity, changed };
      });
      const movementIds: number[] = [];
      for (const item of prepared) {
        if (!item.changed) continue;
        const movement = await this.inventory.applyStock(tx, item.product.productId, storeId, item.before, item.after, {
          operationKey: dto.requestKey, kind: 'COUNT_ADJUSTMENT', presentationId: item.before.basePresentationId,
          quantity: item.total, actorId: actor.id, note,
          details: { source: 'STORE_COUNT', countedPresentations: item.product.counts },
        });
        movementIds.push(movement.id);
      }
      return {
        storeId, storeName: store.name, countedProducts: products.length,
        countedPresentations: products.reduce((sum, product) => sum + product.counts.length, 0),
        adjustedProducts: movementIds.length, movementIds, countedAt: new Date().toISOString(),
        // Persist unchanged counts too, without manufacturing stock movements or version changes.
        audit: { note, countedItems: products },
      };
    });
    const { audit: _audit, ...summary } = result;
    return summary;
  }
}

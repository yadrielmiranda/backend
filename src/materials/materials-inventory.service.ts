import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import {
  MaterialAdjustmentDto, MaterialInternalUseDto, MaterialPresentationCreateDto, MaterialPresentationUpdateDto, MaterialPresentationDeleteDto,
  MaterialProductCreateDto, MaterialProductUpdateDto, MaterialReceiptDto, MaterialRepackDto, MaterialTransferDto,
  MaterialUnitCreateDto, MaterialUnitUpdateDto,
  MaterialCategoryCreateDto, MaterialCategoryUpdateDto,
} from './materials.dto';
import { validateMaterialImageUrl } from './materials-images';
import { assertMaterialDailyOperation } from './materials-operation-policy';
import { materialAvailability, MaterialStockError, MaterialStockState, repackMaterial, withdrawMaterial } from './materials-stock';

type Tx = Prisma.TransactionClient;
type Query = Record<string, string>;
type MovementContext = {
  operationKey: string; kind: string; presentationId?: number; quantity: number; actorId?: number; saleId?: number;
  note?: string; recipient?: string; details?: any; costPerPackage?: number; supplier?: string; reference?: string;
};
const asJson = (value: unknown): any => JSON.parse(JSON.stringify(value));
function referencesPresentation(value: Prisma.JsonValue, id: number): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => referencesPresentation(item, id));
  if (value.presentationId === id || value.presentationId === String(id)) return true;
  return Object.values(value).some(item => referencesPresentation(item, id));
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
const text = (value: string | null | undefined) => value?.trim() || null;
const requiredText = (value: string, label: string) => {
  const clean = text(value); if (!clean) throw new BadRequestException(`${label} is required.`); return clean;
};
const paging = (query: Query) => {
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 25));
  return { page: Math.floor(page), pageSize: Math.floor(pageSize), skip: (Math.floor(page) - 1) * Math.floor(pageSize) };
};

@Injectable()
export class MaterialsInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  staff(actor: AuthUser, admin = false) {
    if (!actor?.id || !(admin ? ['admin'] : ['admin', 'operator']).includes(actor.role?.name ?? ''))
      throw new ForbiddenException('Materials are available to authorized staff only.');
  }

  async operation<T>(requestKey: string, payload: unknown, actorId: number | null, kind: string, work: (tx: Tx) => Promise<T>): Promise<T & { replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(canonical({ kind, actorId, payload }))).digest('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const prior = await tx.materialOperation.findUnique({ where: { requestKey } });
          if (prior) {
            if (prior.requestHash !== requestHash) throw new ConflictException('This request was already used for another operation.');
            return { ...prior.result as object, replayed: true } as T & { replayed: boolean };
          }
          await tx.materialOperation.create({ data: { requestKey, requestHash, kind, actorId, result: {} } });
          const result = asJson(await work(tx));
          await tx.materialOperation.update({ where: { requestKey }, data: { result } });
          return { ...result, replayed: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
      } catch (error) {
        if (error instanceof MaterialStockError) throw new ConflictException(error.message);
        if (['P2002', 'P2034'].includes(error?.code)) {
          if (attempt < 2) continue;
          throw new ConflictException(error.code === 'P2002' ? 'This name, barcode or presentation already exists.' : 'Inventory changed. Retry the same operation.');
        }
        throw error;
      }
    }
  }

  async lockProducts(tx: Tx, ids: number[]) {
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('Select a valid product.');
      const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM material_products WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Material product not found.');
    }
  }

  async lockStores(tx: Tx, ids: number[], activeIds = ids) {
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      await tx.$queryRaw`SELECT id FROM warehouse_stores WHERE id = ${id} FOR UPDATE`;
      const store = await tx.warehouseStore.findUnique({ where: { id } });
      if (!store) throw new NotFoundException('Store not found.');
      if (activeIds.includes(id) && !store.isActive) throw new ConflictException('This store is inactive.');
    }
  }

  async loadStock(tx: Tx, productId: number, storeId: number, excludeSaleId?: number): Promise<MaterialStockState> {
    const presentations = await tx.materialPresentation.findMany({ where: { productId }, orderBy: { id: 'asc' } });
    const base = presentations.find(p => p.isBase);
    if (!base) throw new NotFoundException('Material product not found.');
    const stocks = await tx.materialStock.findMany({ where: { productId, storeId } });
    const reservations = await tx.materialSaleLine.findMany({
      where: { productId, storeId, ...(excludeSaleId ? { saleId: { not: excludeSaleId } } : {}), sale: { status: 'CONFIRMED' } },
      select: { presentationId: true, quantity: true },
    });
    return {
      basePresentationId: base.id,
      packs: presentations.map(p => ({ id: p.id, baseUnits: p.multiplier, quantity: stocks.find(s => s.presentationId === p.id)?.quantity ?? 0 })),
      reservations,
    };
  }

  async applyStock(tx: Tx, productId: number, storeId: number, before: MaterialStockState, after: MaterialStockState, context: MovementContext) {
    const availability = materialAvailability(after);
    const beforeAvailability = materialAvailability(before);
    const changes = [];
    for (const pack of after.packs) {
      const old = before.packs.find(p => p.id === pack.id);
      if (!old || old.baseUnits !== pack.baseUnits) throw new BadRequestException('Invalid stock presentation.');
      if (old.quantity === pack.quantity) continue;
      changes.push({ presentationId: pack.id, before: old.quantity, after: pack.quantity });
      await tx.materialStock.upsert({
        where: { presentationId_storeId: { presentationId: pack.id, storeId } },
        create: { productId, presentationId: pack.id, storeId, quantity: pack.quantity },
        update: { quantity: pack.quantity, version: { increment: 1 } },
      });
    }
    if (!changes.length) throw new BadRequestException('This operation does not change inventory.');
    await tx.materialProduct.update({ where: { id: productId }, data: { version: { increment: 1 } } });
    const { details, costPerPackage, ...rest } = context;
    const totalCost = costPerPackage === undefined ? undefined : new Prisma.Decimal(costPerPackage).mul(context.quantity);
    if (totalCost?.greaterThan('9999999999.99')) throw new BadRequestException('The receipt cost exceeds the supported limit.');
    return tx.materialMovement.create({ data: {
      ...rest, productId, storeId, costPerPackage, totalCost,
      deltaBaseUnits: availability.totalBaseQuantity - beforeAvailability.totalBaseQuantity,
      baseUnitsAfter: availability.totalBaseQuantity,
      details: asJson({ changes, ...(details ?? {}) }),
    } });
  }

  async deliverSale(tx: Tx, sale: { id: number; storeId?: number; lines: { productId: number; presentationId: number; quantity: number; storeId: number }[] }, operationKey: string, actorId?: number) {
    await this.lockProducts(tx, sale.lines.map(l => l.productId));
    await this.lockStores(tx, sale.lines.map(l => l.storeId));
    const movements = [];
    const groups = [...new Set(sale.lines.map(l => `${l.productId}:${l.storeId}`))];
    for (const key of groups) {
      const [productId, storeId] = key.split(':').map(Number);
      const product = await tx.materialProduct.findUnique({ where: { id: productId } });
      let state = await this.loadStock(tx, productId, storeId, sale.id);
      const lines = sale.lines.filter(l => l.productId === productId && l.storeId === storeId)
        .sort((a, b) => Number(a.presentationId === state.basePresentationId) - Number(b.presentationId === state.basePresentationId));
      // Protect this sale's remaining lines as well as other sales during each withdrawal.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const pack = state.packs.find(pack => pack.id === line.presentationId);
        if (!pack) throw new BadRequestException('Unknown material presentation.');
        assertMaterialDailyOperation(product, { isBase: line.presentationId === state.basePresentationId, multiplier: pack.baseUnits });
        const working = { ...state, reservations: [...state.reservations, ...lines.slice(i + 1).map(l => ({ presentationId: l.presentationId, quantity: l.quantity }))] };
        const next = withdrawMaterial(working, line.presentationId, line.quantity);
        movements.push(await this.applyStock(tx, productId, storeId, working, next, {
          operationKey, kind: 'SALE_DELIVERY', presentationId: line.presentationId, quantity: line.quantity,
          actorId, saleId: sale.id, details: { opened: next.opened },
        }));
        state = { ...next, reservations: state.reservations };
      }
    }
    return movements;
  }

  async units(actor: AuthUser) {
    this.staff(actor);
    return this.prisma.materialUnit.findMany({ orderBy: { name: 'asc' } });
  }

  async categories(actor: AuthUser) {
    this.staff(actor);
    return this.prisma.materialCategory.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  async createCategory(dto: MaterialCategoryCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, dto, actor.id, 'CREATE_CATEGORY', tx => tx.materialCategory.create({ data: { name: requiredText(dto.name, 'Category name') } }));
  }

  async updateCategory(id: number, dto: MaterialCategoryUpdateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { id, ...dto }, actor.id, 'UPDATE_CATEGORY', async tx => {
      if (!await tx.materialCategory.findUnique({ where: { id } })) throw new NotFoundException('Category not found.');
      return tx.materialCategory.update({ where: { id }, data: {
        ...(dto.name !== undefined ? { name: requiredText(dto.name, 'Category name') } : {}), isActive: dto.isActive,
      } });
    });
  }

  private async catalogFields(tx: Tx, dto: { categoryId?: number | null; brand?: string | null; imageUrl?: string | null }, currentCategoryId?: number | null) {
    if (dto.categoryId != null && dto.categoryId !== currentCategoryId) {
      const category = await tx.materialCategory.findUnique({ where: { id: dto.categoryId } });
      if (!category?.isActive) throw new BadRequestException('Select an active material category.');
    }
    return {
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.brand !== undefined ? { brand: text(dto.brand) } : {}),
      ...(dto.imageUrl !== undefined ? { imageUrl: await validateMaterialImageUrl(text(dto.imageUrl)) } : {}),
    };
  }

  async createUnit(dto: MaterialUnitCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, dto, actor.id, 'CREATE_UNIT', tx => tx.materialUnit.create({ data: { name: requiredText(dto.name, 'Unit name') } }));
  }

  async updateUnit(id: number, dto: MaterialUnitUpdateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { id, ...dto }, actor.id, 'UPDATE_UNIT', async tx => {
      const found = await tx.materialUnit.findUnique({ where: { id } });
      if (!found) throw new NotFoundException('Unit not found.');
      if (dto.isActive === false && await tx.materialPresentation.count({ where: { unitId: id, isActive: true } }))
        throw new ConflictException('This unit is used by active material presentations.');
      return tx.materialUnit.update({ where: { id }, data: { ...(dto.name !== undefined ? { name: requiredText(dto.name, 'Unit name') } : {}), isActive: dto.isActive } });
    });
  }

  private async unit(tx: Tx, id: number) {
    const unit = await tx.materialUnit.findUnique({ where: { id } });
    if (!unit?.isActive) throw new BadRequestException('Select an active unit of measure.');
    return unit;
  }

  private barcode(value?: string | null, generate = false) {
    if (generate && text(value)) throw new BadRequestException('Enter a barcode or generate one, not both.');
    const code = generate ? `MAT-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}` : text(value);
    if (code && !/^[\x21-\x7E]{1,120}$/.test(code)) throw new BadRequestException('Barcodes must contain printable ASCII characters without spaces.');
    return code;
  }

  async createProduct(dto: MaterialProductCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, dto, actor.id, 'CREATE_PRODUCT', async tx => {
      const base = await this.unit(tx, dto.baseUnitId);
      const purchase = await this.unit(tx, dto.purchaseUnitId);
      const same = dto.baseUnitId === dto.purchaseUnitId && dto.purchaseMultiplier === 1;
      if (dto.allowBaseUnitOperations === false && dto.purchaseMultiplier <= 1)
        throw new BadRequestException('Choose a purchase package containing more than one base unit before restricting daily operations to packages.');
      const baseBarcode = this.barcode(dto.baseBarcode);
      const purchaseBarcode = this.barcode(dto.purchaseBarcode);
      if (same && baseBarcode && purchaseBarcode && baseBarcode !== purchaseBarcode)
        throw new BadRequestException('A single-unit purchase uses the same base presentation and barcode.');
      const product = await tx.materialProduct.create({ data: {
        name: requiredText(dto.name, 'Product name'), description: text(dto.description), baseUnitId: base.id, code: `MAT-${randomUUID()}`,
        allowBaseUnitOperations: dto.allowBaseUnitOperations ?? true,
        ...await this.catalogFields(tx, dto),
      } });
      await tx.materialProduct.update({ where: { id: product.id }, data: { code: `MAT-${String(product.id).padStart(6, '0')}` } });
      await tx.materialPresentation.create({ data: {
        productId: product.id, unitId: base.id, name: base.name, multiplier: 1, barcode: baseBarcode ?? (same ? purchaseBarcode : null), isBase: true, isPurchase: same,
      } });
      if (!same) await tx.materialPresentation.create({ data: {
        productId: product.id, unitId: purchase.id, name: `${purchase.name} (${dto.purchaseMultiplier} ${base.name})`.slice(0, 120),
        multiplier: dto.purchaseMultiplier, barcode: purchaseBarcode, isPurchase: true,
      } });
      return this.presentProduct(tx, product.id);
    });
  }

  async updateProduct(id: number, dto: MaterialProductUpdateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { id, ...dto }, actor.id, 'UPDATE_PRODUCT', async tx => {
      await this.lockProducts(tx, [id]);
      const product = await tx.materialProduct.findUnique({ where: { id } });
      if (product.version !== dto.version) throw new ConflictException('The product changed. Reload before saving.');
      if (dto.allowBaseUnitOperations === false) {
        if (!await tx.materialPresentation.count({ where: { productId: id, isActive: true, isBase: false, multiplier: { gt: 1 } } }))
          throw new BadRequestException('Create an active package containing more than one base unit before restricting daily operations to packages.');
        if (await tx.materialSaleLine.count({ where: { productId: id, multiplier: 1, sale: { status: 'CONFIRMED' } } }))
          throw new ConflictException('Complete or cancel confirmed sales of single units before restricting this material to packages.');
      }
      if (dto.isActive === false && (await tx.materialStock.count({ where: { productId: id, quantity: { gt: 0 } } }) ||
        await tx.materialSaleLine.count({ where: { productId: id, sale: { status: 'CONFIRMED' } } })))
        throw new ConflictException('A product with inventory or reserved sales cannot be deactivated.');
      await tx.materialProduct.update({ where: { id }, data: {
        ...(dto.name !== undefined ? { name: requiredText(dto.name, 'Product name') } : {}),
        ...(dto.description !== undefined ? { description: text(dto.description) } : {}),
        ...await this.catalogFields(tx, dto, product.categoryId),
        isActive: dto.isActive, isSaleEnabled: dto.isSaleEnabled, allowBaseUnitOperations: dto.allowBaseUnitOperations, version: { increment: 1 },
      } });
      return this.presentProduct(tx, id);
    });
  }

  async createPresentation(productId: number, dto: MaterialPresentationCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { productId, ...dto }, actor.id, 'CREATE_PRESENTATION', async tx => {
      await this.lockProducts(tx, [productId]);
      const unit = await this.unit(tx, dto.unitId);
      const product = await tx.materialProduct.findUnique({ where: { id: productId }, include: { baseUnit: true } });
      if (!product.isActive) throw new ConflictException('The product is inactive.');
      if (dto.isPurchase || dto.isSaleEnabled) assertMaterialDailyOperation(product, { multiplier: dto.multiplier });
      if (dto.isSaleEnabled && !(dto.salePrice > 0)) throw new BadRequestException('Enter a positive sale price before enabling this presentation.');
      await tx.materialPresentation.create({ data: {
        productId, unitId: dto.unitId, multiplier: dto.multiplier,
        name: dto.name !== undefined ? requiredText(dto.name, 'Presentation name') : `${unit.name} (${dto.multiplier} ${product.baseUnit.name})`.slice(0, 120),
        barcode: this.barcode(dto.barcode, dto.generateBarcode), isPurchase: dto.isPurchase ?? false,
        isSaleEnabled: dto.isSaleEnabled ?? false, salePrice: dto.salePrice,
      } });
      await tx.materialProduct.update({ where: { id: productId }, data: { version: { increment: 1 } } });
      return this.presentProduct(tx, productId);
    });
  }

  async updatePresentation(id: number, dto: MaterialPresentationUpdateDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { id, ...dto }, actor.id, 'UPDATE_PRESENTATION', async tx => {
      const initial = await tx.materialPresentation.findUnique({ where: { id } });
      if (!initial) throw new NotFoundException('Presentation not found.');
      await this.lockProducts(tx, [initial.productId]);
      const presentation = await tx.materialPresentation.findUnique({ where: { id } });
      if (!presentation) throw new NotFoundException('Presentation not found. Reload the product.');
      if (presentation.version !== dto.version) throw new ConflictException('The presentation changed. Reload before saving.');
      const product = await tx.materialProduct.findUnique({ where: { id: presentation.productId } });
      if (dto.isPurchase === true || dto.isSaleEnabled === true) assertMaterialDailyOperation(product, presentation);
      if (dto.isActive === false) await this.requireRemainingPackage(tx, product, id);
      if (dto.isActive === false && (presentation.isBase || await tx.materialStock.count({ where: { presentationId: id, quantity: { gt: 0 } } }) ||
        await tx.materialSaleLine.count({ where: { presentationId: id, sale: { status: 'CONFIRMED' } } })))
        throw new ConflictException('This presentation is required by existing stock, reservations or the base unit.');
      const price = dto.salePrice === undefined ? presentation.salePrice : dto.salePrice;
      if ((dto.isSaleEnabled ?? presentation.isSaleEnabled) && !(Number(price) > 0)) throw new BadRequestException('Enter a positive sale price before enabling this presentation.');
      await tx.materialPresentation.update({ where: { id }, data: {
        ...(dto.name !== undefined ? { name: requiredText(dto.name, 'Presentation name') } : {}),
        ...(dto.barcode !== undefined || dto.generateBarcode ? { barcode: this.barcode(dto.barcode, dto.generateBarcode) } : {}),
        isPurchase: dto.isPurchase, isSaleEnabled: dto.isSaleEnabled, isActive: dto.isActive, salePrice: dto.salePrice,
        version: { increment: 1 },
      } });
      await tx.materialProduct.update({ where: { id: initial.productId }, data: { version: { increment: 1 } } });
      return this.presentProduct(tx, initial.productId);
    });
  }

  private async presentationHasMovements(tx: Tx, id: number, productId: number) {
    if (await tx.materialMovement.count({ where: { presentationId: id } })) return true;
    // Opening packages and physical counts can reference a presentation only in the
    // movement details. Read indexed product history in bounded batches, not just its balance.
    let afterId = 0;
    while (true) {
      const movements = await tx.materialMovement.findMany({
        where: { productId, id: { gt: afterId } }, select: { id: true, details: true },
        orderBy: { id: 'asc' }, take: 200,
      });
      if (movements.some(movement => referencesPresentation(movement.details, id))) return true;
      if (movements.length < 200) return false;
      afterId = movements[movements.length - 1].id;
    }
  }

  private async requireRemainingPackage(tx: Tx, product: { id: number; allowBaseUnitOperations: boolean }, excludedId: number) {
    if (product.allowBaseUnitOperations === false && !await tx.materialPresentation.count({ where: {
      productId: product.id, id: { not: excludedId }, isActive: true, isBase: false, multiplier: { gt: 1 },
    } })) throw new ConflictException('Keep at least one active package while daily base-unit operations are disabled.');
  }

  async deletePresentation(id: number, dto: MaterialPresentationDeleteDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, { id, ...dto }, actor.id, 'DELETE_PRESENTATION', async tx => {
      const initial = await tx.materialPresentation.findUnique({ where: { id } });
      if (!initial) throw new NotFoundException('Presentation not found. Reload the product.');
      await this.lockProducts(tx, [initial.productId]);
      const presentation = await tx.materialPresentation.findUnique({ where: { id } });
      if (!presentation) throw new NotFoundException('Presentation not found. Reload the product.');
      if (presentation.version !== dto.version) throw new ConflictException('The presentation changed. Reload before deleting.');
      if (presentation.isBase) throw new ConflictException('The base presentation cannot be deleted.');
      const product = await tx.materialProduct.findUnique({ where: { id: presentation.productId } });
      await this.requireRemainingPackage(tx, product, id);
      if (await tx.materialStock.count({ where: { presentationId: id, quantity: { not: 0 } } }))
        throw new ConflictException('This presentation has inventory and cannot be deleted.');
      if (await tx.materialSaleLine.count({ where: { presentationId: id } }))
        throw new ConflictException('This presentation is linked to a sale and cannot be deleted.');
      if (await this.presentationHasMovements(tx, id, presentation.productId))
        throw new ConflictException('This presentation has inventory movements and cannot be deleted. You can deactivate it instead.');
      await tx.materialStock.deleteMany({ where: { presentationId: id, quantity: 0 } });
      await tx.materialPresentation.delete({ where: { id } });
      await tx.materialProduct.update({ where: { id: presentation.productId }, data: { version: { increment: 1 } } });
      // Preserve the deleted catalog entry in the existing operation audit; no stock movement is created.
      return { id, productId: presentation.productId, deletedPresentation: presentation };
    }).catch(error => {
      if (error?.code === 'P2003') throw new ConflictException('This presentation is in use and cannot be deleted. Reload the product.');
      throw error;
    });
  }

  async presentProduct(tx: Tx, id: number, selectedStoreId?: number) {
    const product = await tx.materialProduct.findUnique({ where: { id }, include: { baseUnit: true, category: true, presentations: { include: { unit: true }, orderBy: [{ isBase: 'desc' }, { id: 'asc' }] } } });
    if (!product) throw new NotFoundException('Material product not found.');
    const [stores, stocks, reservations] = await Promise.all([
      tx.warehouseStore.findMany({ where: selectedStoreId ? { id: selectedStoreId } : {}, select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } }),
      tx.materialStock.findMany({ where: { productId: id, ...(selectedStoreId ? { storeId: selectedStoreId } : {}) } }),
      tx.materialSaleLine.findMany({ where: { productId: id, ...(selectedStoreId ? { storeId: selectedStoreId } : {}), sale: { status: 'CONFIRMED' } }, select: { presentationId: true, quantity: true, storeId: true } }),
    ]);
    const inventoryByStore = stores.map(store => ({ store, ...materialAvailability({
      basePresentationId: product.presentations.find(p => p.isBase)?.id,
      packs: product.presentations.map(p => ({ id: p.id, baseUnits: p.multiplier, quantity: stocks.find(s => s.presentationId === p.id && s.storeId === store.id)?.quantity ?? 0 })),
      reservations: reservations.filter(r => r.storeId === store.id),
    }) }));
    const sum = (key: string) => inventoryByStore.reduce((total, s) => total + s[key], 0);
    return {
      ...product,
      totalBaseQuantity: sum('totalBaseQuantity'), reservedBaseQuantity: sum('reservedBaseQuantity'), availableBaseQuantity: sum('availableBaseQuantity'),
      presentations: product.presentations.map(p => ({
        ...p, salePrice: p.salePrice == null ? null : Number(p.salePrice),
        quantity: inventoryByStore.reduce((sum, s) => sum + (s.presentations.find(x => x.id === p.id)?.quantity ?? 0), 0),
        reservedQuantity: inventoryByStore.reduce((sum, s) => sum + (s.presentations.find(x => x.id === p.id)?.reservedQuantity ?? 0), 0),
        availableQuantity: inventoryByStore.reduce((sum, s) => sum + (s.presentations.find(x => x.id === p.id)?.availableQuantity ?? 0), 0),
      })),
      inventoryByStore,
    };
  }

  async products(query: Query, actor: AuthUser) {
    this.staff(actor);
    const { page, pageSize, skip } = paging(query);
    const search = text(query.search);
    const where: Prisma.MaterialProductWhereInput = search ? { OR: [{ name: { contains: search } }, { code: { contains: search } }, { description: { contains: search } }, { presentations: { some: { barcode: search } } }] } : {};
    const storeId = query.storeId ? Number(query.storeId) : undefined;
    if (storeId !== undefined && (!Number.isInteger(storeId) || storeId < 1)) throw new BadRequestException('Select a valid store.');
    return this.prisma.$transaction(async tx => {
      const [rows, total] = await Promise.all([
        tx.materialProduct.findMany({ where, select: { id: true }, orderBy: { id: 'desc' }, skip, take: pageSize }),
        tx.materialProduct.count({ where }),
      ]);
      const items = await Promise.all(rows.map(row => this.presentProduct(tx, row.id, storeId)));
      return { items, total, page, pageSize };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
  }

  async product(id: number, actor: AuthUser) {
    this.staff(actor);
    return this.prisma.$transaction(tx => this.presentProduct(tx, id), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async findBarcode(barcode: string, actor: AuthUser) {
    this.staff(actor);
    return this.prisma.$transaction(async tx => {
      const presentation = await tx.materialPresentation.findUnique({ where: { barcode: requiredText(barcode, 'Barcode') } });
      if (!presentation) throw new NotFoundException('No material presentation has this barcode.');
      const product = await this.presentProduct(tx, presentation.productId);
      return { product, presentation: product.presentations.find(p => p.id === presentation.id) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async stockContext(tx: Tx, productId: number, presentationId: number, storeIds: number[], dailyOperation = true) {
    await this.lockProducts(tx, [productId]);
    await this.lockStores(tx, storeIds);
    const product = await tx.materialProduct.findUnique({ where: { id: productId } });
    const presentation = await tx.materialPresentation.findUnique({ where: { id: presentationId } });
    if (!product.isActive || !presentation?.isActive || presentation.productId !== productId) throw new BadRequestException('Select an active presentation belonging to this product.');
    if (dailyOperation) assertMaterialDailyOperation(product, presentation);
    return { product, presentation };
  }

  async receive(dto: MaterialReceiptDto, actor: AuthUser) {
    this.staff(actor);
    return this.operation(dto.requestKey, dto, actor.id, 'RECEIVE', async tx => {
      const { presentation } = await this.stockContext(tx, dto.productId, dto.presentationId, [dto.storeId]);
      if (!presentation.isPurchase) throw new BadRequestException('This presentation is not configured for purchases.');
      const before = await this.loadStock(tx, dto.productId, dto.storeId);
      const after = { ...before, packs: before.packs.map(p => ({ ...p, quantity: p.quantity + (p.id === dto.presentationId ? dto.quantity : 0) })) };
      const movement = await this.applyStock(tx, dto.productId, dto.storeId, before, after, {
        operationKey: dto.requestKey, kind: 'RECEIVE', presentationId: dto.presentationId, quantity: dto.quantity, actorId: actor.id,
        costPerPackage: dto.costPerPackage, supplier: text(dto.supplier), reference: text(dto.reference), note: text(dto.note),
      });
      return { movement, product: await this.presentProduct(tx, dto.productId) };
    });
  }

  async internalUse(dto: MaterialInternalUseDto, actor: AuthUser) {
    this.staff(actor);
    return this.operation(dto.requestKey, dto, actor.id, 'INTERNAL_USE', async tx => {
      await this.stockContext(tx, dto.productId, dto.presentationId, [dto.storeId]);
      const before = await this.loadStock(tx, dto.productId, dto.storeId);
      const after = withdrawMaterial(before, dto.presentationId, dto.quantity);
      const movement = await this.applyStock(tx, dto.productId, dto.storeId, before, after, {
        operationKey: dto.requestKey, kind: 'INTERNAL_USE', presentationId: dto.presentationId, quantity: dto.quantity, actorId: actor.id,
        note: requiredText(dto.note, 'Reason'), recipient: requiredText(dto.recipient, 'Recipient'), details: { opened: after.opened },
      });
      return { movement, product: await this.presentProduct(tx, dto.productId) };
    });
  }

  async repack(dto: MaterialRepackDto, actor: AuthUser) {
    this.staff(actor);
    return this.operation(dto.requestKey, dto, actor.id, dto.action, async tx => {
      await this.stockContext(tx, dto.productId, dto.presentationId, [dto.storeId], false);
      const before = await this.loadStock(tx, dto.productId, dto.storeId);
      const after = repackMaterial(before, dto.presentationId, dto.quantity, dto.action);
      const movement = await this.applyStock(tx, dto.productId, dto.storeId, before, after, {
        operationKey: dto.requestKey, kind: dto.action, presentationId: dto.presentationId, quantity: dto.quantity, actorId: actor.id, note: text(dto.note),
      });
      return { movement, product: await this.presentProduct(tx, dto.productId) };
    });
  }

  async transfer(dto: MaterialTransferDto, actor: AuthUser) {
    this.staff(actor);
    if (dto.fromStoreId === dto.toStoreId) throw new BadRequestException('Select a different destination store.');
    return this.operation(dto.requestKey, dto, actor.id, 'TRANSFER', async tx => {
      await this.stockContext(tx, dto.productId, dto.presentationId, [dto.fromStoreId, dto.toStoreId]);
      const source = await this.loadStock(tx, dto.productId, dto.fromStoreId);
      const destination = await this.loadStock(tx, dto.productId, dto.toStoreId);
      const fromNext = withdrawMaterial(source, dto.presentationId, dto.quantity);
      const toNext = { ...destination, packs: destination.packs.map(p => ({ ...p, quantity: p.quantity + (p.id === dto.presentationId ? dto.quantity : 0) })) };
      const context = { operationKey: dto.requestKey, presentationId: dto.presentationId, quantity: dto.quantity, actorId: actor.id, note: text(dto.note), details: { fromStoreId: dto.fromStoreId, toStoreId: dto.toStoreId, opened: fromNext.opened } };
      const movements = [
        await this.applyStock(tx, dto.productId, dto.fromStoreId, source, fromNext, { ...context, kind: 'TRANSFER_OUT' }),
        await this.applyStock(tx, dto.productId, dto.toStoreId, destination, toNext, { ...context, kind: 'TRANSFER_IN' }),
      ];
      return { movements, product: await this.presentProduct(tx, dto.productId) };
    });
  }

  async adjust(dto: MaterialAdjustmentDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.operation(dto.requestKey, dto, actor.id, 'ADJUST', async tx => {
      const { product } = await this.stockContext(tx, dto.productId, dto.presentationId, [dto.storeId], false);
      if (product.version !== dto.version) throw new ConflictException('Stock changed since you started this count. Reload and count again.');
      const before = await this.loadStock(tx, dto.productId, dto.storeId);
      const after = { ...before, packs: before.packs.map(p => ({ ...p, quantity: p.id === dto.presentationId ? dto.quantity : p.quantity })) };
      const movement = await this.applyStock(tx, dto.productId, dto.storeId, before, after, {
        operationKey: dto.requestKey, kind: 'ADJUST', presentationId: dto.presentationId, quantity: dto.quantity, actorId: actor.id, note: requiredText(dto.note, 'Adjustment reason'),
      });
      return { movement, product: await this.presentProduct(tx, dto.productId) };
    });
  }

  async history(query: Query, actor: AuthUser) {
    this.staff(actor);
    const { page, pageSize, skip } = paging(query);
    const where: Prisma.MaterialMovementWhereInput = {};
    for (const key of ['productId', 'storeId'] as const) if (query[key]) {
      const id = Number(query[key]); if (!Number.isInteger(id) || id < 1) throw new BadRequestException('Invalid history filter.'); where[key] = id;
    }
    const [items, total] = await Promise.all([
      this.prisma.materialMovement.findMany({ where, include: { product: { select: { id: true, code: true, name: true } }, presentation: { select: { id: true, name: true, multiplier: true } }, store: { select: { id: true, name: true } } }, orderBy: { id: 'desc' }, skip, take: pageSize }),
      this.prisma.materialMovement.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}

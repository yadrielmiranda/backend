import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialsInventoryService } from './materials-inventory.service';
import { MaterialStoreIssueDto } from './materials-store-issue.dto';
import { MaterialStockError, MaterialStockState, withdrawMaterial } from './materials-stock';

const integer = (value: unknown, max = 2147483647): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;

@Injectable()
export class MaterialsStoreIssueService {
  constructor(private readonly prisma: PrismaService, private readonly inventory: MaterialsInventoryService) {}

  private validate(storeId: number, dto: MaterialStoreIssueDto) {
    if (!integer(storeId)) throw new BadRequestException('Select a valid store.');
    if (!dto || typeof dto.requestKey !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(dto.requestKey))
      throw new BadRequestException('A valid issue request is required.');
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim() || dto.recipient.length > 200)
      throw new BadRequestException('Enter the recipient, up to 200 characters.');
    if (typeof dto.note !== 'string' || !dto.note.trim() || dto.note.length > 1000)
      throw new BadRequestException('Enter a reason or job reference, up to 1000 characters.');
    if (!Array.isArray(dto.lines) || !dto.lines.length || dto.lines.length > 1000)
      throw new BadRequestException('Select between 1 and 1000 material presentations.');
    const presentationIds = new Set<number>();
    for (const line of dto.lines) {
      if (!line || !integer(line.productId) || !integer(line.presentationId) || presentationIds.has(line.presentationId))
        throw new BadRequestException('Each selected presentation must have a unique, valid ID.');
      presentationIds.add(line.presentationId);
      if (!integer(line.quantity, 1000000))
        throw new BadRequestException('Issue quantities must be whole numbers from 1 to 1,000,000.');
    }
  }

  async internalUse(storeId: number, dto: MaterialStoreIssueDto, actor: AuthUser) {
    this.inventory.staff(actor);
    this.validate(storeId, dto);
    const lines = [...dto.lines].sort((a, b) => a.productId - b.productId || a.presentationId - b.presentationId);
    const productIds = [...new Set(lines.map(line => line.productId))];
    const recipient = dto.recipient.trim();
    const note = dto.note.trim();
    return this.inventory.operation(dto.requestKey, { storeId, recipient, note, lines }, actor.id, 'STORE_INTERNAL_USE', async tx => {
      await this.inventory.lockProducts(tx, productIds);
      await this.inventory.lockStores(tx, [storeId]);
      const store = await tx.warehouseStore.findUnique({ where: { id: storeId }, select: { id: true, name: true, isActive: true } });
      if (!store?.isActive) throw new ConflictException('This store is inactive.');
      const [products, stocks, reservations] = await Promise.all([
        tx.materialProduct.findMany({ where: { id: { in: productIds } }, select: {
          id: true, name: true, isActive: true,
          presentations: { select: { id: true, name: true, isActive: true, isBase: true, multiplier: true }, orderBy: { id: 'asc' } },
        } }),
        tx.materialStock.findMany({ where: { storeId, productId: { in: productIds } }, select: { productId: true, presentationId: true, quantity: true } }),
        tx.materialSaleLine.findMany({ where: { storeId, productId: { in: productIds }, sale: { status: 'CONFIRMED' } },
          select: { productId: true, presentationId: true, quantity: true } }),
      ]);
      const byId = new Map(products.map(product => [product.id, product]));
      const stockById = new Map(stocks.map(stock => [stock.presentationId, stock.quantity]));
      const prepared: {
        productId: number; presentationId: number; quantity: number;
        before: MaterialStockState; after: ReturnType<typeof withdrawMaterial>;
      }[] = [];
      // Prepare the complete issue against live stock before saving any line. Package lines go
      // first so a loose-unit request cannot open a box that this same issue needs to keep whole.
      for (const productId of productIds) {
        const product = byId.get(productId);
        if (!product) throw new NotFoundException('Material product not found.');
        if (!product.isActive) throw new ConflictException(`${product.name} is inactive and cannot be issued.`);
        const presentations = new Map(product.presentations.map(presentation => [presentation.id, presentation]));
        const base = product.presentations.find(presentation => presentation.isBase);
        if (!base) throw new ConflictException(`${product.name} is missing its base-unit presentation.`);
        const requested = lines.filter(line => line.productId === productId);
        for (const line of requested) {
          if (!presentations.get(line.presentationId)?.isActive)
            throw new BadRequestException('Select active presentations belonging to the selected product.');
        }
        requested.sort((a, b) => Number(a.presentationId === base.id) - Number(b.presentationId === base.id) || a.presentationId - b.presentationId);
        let state: MaterialStockState = {
          basePresentationId: base.id,
          packs: product.presentations.map(presentation => ({ id: presentation.id, baseUnits: presentation.multiplier, quantity: stockById.get(presentation.id) ?? 0 })),
          reservations: reservations.filter(reservation => reservation.productId === productId),
        };
        for (const line of requested) {
          try {
            const after = withdrawMaterial(state, line.presentationId, line.quantity);
            prepared.push({ ...line, before: state, after });
            state = after;
          } catch (error) {
            if (error instanceof MaterialStockError) throw new MaterialStockError(`${product.name}: ${error.message}`);
            throw error;
          }
        }
      }
      const movementIds: number[] = [];
      for (const line of prepared) {
        const movement = await this.inventory.applyStock(tx, line.productId, storeId, line.before, line.after, {
          operationKey: dto.requestKey, kind: 'INTERNAL_USE', presentationId: line.presentationId,
          quantity: line.quantity, actorId: actor.id, recipient, note,
          details: { source: 'STORE_INTERNAL_USE', opened: line.after.opened },
        });
        movementIds.push(movement.id);
      }
      return { storeId, storeName: store.name, recipient, note, productCount: productIds.length,
        lineCount: lines.length, movementIds, issuedAt: new Date().toISOString() };
    });
  }
}

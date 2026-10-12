import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MAX_FACTORY_LINES } from '@/orders/factory-import/factory-import-matching';
import { MAX_PARTS } from '../warehouse-parts';
import { ExternalPoDocument, parseExternalPo } from './external-po-parser';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFacts = (value: { mark: string | null; description: string | null; panels: number | null }) =>
  [value.mark ?? '', value.description ?? '', value.panels];
const poInclude = {
  externalUnits: {
    orderBy: { lineNumber: 'asc' as const },
    include: { stock: { include: { _count: { select: { movements: true, countLines: true, pickupRunLines: true } } } } },
  },
} satisfies Prisma.FactoryPoInclude;
type Po = Prisma.FactoryPoGetPayload<{ include: typeof poInclude }>;
type Unit = Po['externalUnits'][number];

function lockedUnit(unit: Unit) {
  const stock = unit.stock;
  return !!stock && (stock.version > 0 || stock.inTransit > 0 || stock.onHand > 0 || stock.unassigned > 0 || stock.released > 0 ||
    stock._count.movements > 0 || stock._count.countLines > 0 || stock._count.pickupRunLines > 0);
}

@Injectable()
export class ExternalPoService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthUser) {
    if (actor.role?.name !== 'admin') throw new ForbiddenException('Only administrators can import external POs.');
  }

  private async load(db: Prisma.TransactionClient, document: ExternalPoDocument) {
    const [order, po] = await Promise.all([
      db.order.findUnique({ where: { poNumber: document.poNumber }, select: { id: true } }),
      db.factoryPo.findUnique({ where: { poNumber: document.poNumber }, include: poInclude }),
    ]);
    if (order || po?.orderId !== null && po?.orderId !== undefined)
      throw new ConflictException('This PO is already associated with a system order. Use its factory import.');
    const incoming = new Set(document.lines.map((line) => line.lineNumber));
    if (po?.externalUnits.some((unit) => !incoming.has(unit.lineNumber)))
      throw new ConflictException('This file omits previously imported factory lines. Export the complete PO; existing units are preserved.');
    const linked = await db.factoryUnit.findMany({
      where: { lineNumber: { in: [...incoming] } },
      select: { lineNumber: true, externalPoId: true },
    });
    const conflict = linked.find((unit) => !po || unit.externalPoId !== po.id);
    if (conflict) throw new ConflictException(`Factory line ${conflict.lineNumber} already belongs to another PO or system order.`);
    const [activePickup, activeCount] = await Promise.all([
      po ? db.factoryPickupRunOrder.findFirst({ where: { externalPoId: po.id, activeSlot: 1 }, select: { pickupRunId: true } }) : null,
      db.warehouseCount.findUnique({ where: { activeSlot: 1 }, select: { id: true } }),
    ]);
    const units = new Map(po?.externalUnits.map((unit) => [unit.lineNumber, unit]) ?? []);
    if (po?.externalUnits.some(lockedUnit) && (document.orderName !== (po.orderName ?? '') || document.supplierName !== (po.supplierName ?? '')))
      throw new ConflictException('This PO has warehouse activity or reviewed quantities. Its saved name and supplier cannot be replaced by an import.');
    const lines = document.lines.map((line) => {
      const existing = units.get(line.lineNumber);
      const locked = existing ? lockedUnit(existing) : false;
      const factsChanged = existing && hash(sourceFacts(existing)) !== hash(sourceFacts(line));
      if (locked && factsChanged)
        throw new ConflictException(`Factory line ${line.lineNumber} has warehouse activity or reviewed quantities. Its saved description, mark and panels cannot be replaced by an import.`);
      if (locked && !existing?.stock?.expectedParts)
        throw new ConflictException(`Factory line ${line.lineNumber} needs its expected parts reviewed in the warehouse before importing.`);
      const issues = locked ? [] : [...line.issues];
      if (!locked && existing && (factsChanged || existing.stock?.expectedParts !== line.expectedParts))
        issues.push('This file changes an existing unit. Review its description and expected physical parts.');
      return {
        ...line,
        expectedParts: locked ? existing!.stock!.expectedParts : line.expectedParts,
        needsReview: issues.length > 0,
        issues,
        existing: !!existing,
        locked,
      };
    });
    return {
      po, units, activePickup, activeCount, lines,
      revision: hash([document, po, activePickup, activeCount]),
    };
  }

  async preview(file: Buffer | undefined, actor: AuthUser) {
    this.assertAdmin(actor);
    const document = parseExternalPo(file);
    const data = await this.load(this.prisma, document);
    return {
      revision: data.revision,
      document: { poNumber: document.poNumber, orderName: document.orderName, supplierName: document.supplierName },
      lines: data.lines,
      expectedUnits: document.lines.length,
      linkedUnits: data.units.size,
    };
  }

  async confirm(file: Buffer | undefined, fields: { revision?: string; parts?: string; reviewed?: string }, actor: AuthUser) {
    this.assertAdmin(actor);
    const document = parseExternalPo(file);
    if (!fields.revision || !/^[a-f0-9]{64}$/.test(fields.revision))
      throw new BadRequestException('Preview the file before importing it.');
    let parts: { lineNumber: string; expectedParts: number }[];
    try {
      const raw: unknown = JSON.parse(fields.parts ?? '');
      if (!Array.isArray(raw) || raw.length > MAX_FACTORY_LINES || raw.some((value) =>
        !value || typeof value !== 'object' || typeof value.lineNumber !== 'string' ||
        !Number.isInteger(value.expectedParts) || value.expectedParts < 1 || value.expectedParts > MAX_PARTS)) throw new Error();
      parts = raw.map((value) => ({ lineNumber: value.lineNumber, expectedParts: value.expectedParts }));
    } catch { throw new BadRequestException(`Set expected physical parts between 1 and ${MAX_PARTS} for every factory line.`); }
    const byLine = new Map(parts.map((part) => [part.lineNumber, part.expectedParts]));
    if (parts.length !== document.lines.length || byLine.size !== parts.length || document.lines.some((line) => !byLine.has(line.lineNumber)))
      throw new BadRequestException('Each factory line must have expected physical parts exactly once.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Pickups and movements acquire this same source lock before reading stock.
        await tx.$queryRaw`SELECT id FROM factory_pos WHERE poNumber = ${document.poNumber} FOR UPDATE`;
        const data = await this.load(tx, document);
        if (fields.revision !== data.revision)
          throw new ConflictException('This PO or its warehouse activity changed. Preview the file again before importing.');
        let needsReview = false;
        for (const line of data.lines) {
          const expectedParts = byLine.get(line.lineNumber)!;
          if (line.locked && expectedParts !== line.expectedParts)
            throw new ConflictException(`Expected parts for factory line ${line.lineNumber} are already reviewed or have warehouse activity. Keep the saved quantity.`);
          if (line.needsReview || expectedParts !== line.expectedParts) needsReview = true;
        }
        if (needsReview && fields.reviewed !== 'true')
          throw new BadRequestException('Review the descriptions and expected physical parts before importing.');
        const additions = document.lines.filter((line) => !data.units.has(line.lineNumber));
        const updates = document.lines.filter((line) => {
          const unit = data.units.get(line.lineNumber);
          return unit && !lockedUnit(unit) && (hash(sourceFacts(unit)) !== hash(sourceFacts(line)) || unit.stock?.expectedParts !== byLine.get(line.lineNumber));
        });
        const headerChanged = !data.po || (data.po.orderName ?? '') !== document.orderName || (data.po.supplierName ?? '') !== document.supplierName;
        const changed = additions.length > 0 || updates.length > 0 || headerChanged;
        if (changed && data.activePickup)
          throw new ConflictException('Finish the active factory pickup before importing changes to this PO.');
        if (changed && data.activeCount)
          throw new ConflictException('Finish the open warehouse count before importing changes.');
        if (!changed) return { addedUnits: 0, linkedUnits: document.lines.length, unchanged: true };
        const po = data.po
          ? await tx.factoryPo.update({ where: { id: data.po.id }, data: { orderName: document.orderName || null, supplierName: document.supplierName || null } })
          : await tx.factoryPo.create({ data: { poNumber: document.poNumber, orderName: document.orderName || null, supplierName: document.supplierName || null } });
        if (additions.length) {
          await tx.factoryUnit.createMany({ data: additions.map((line) => ({
            lineNumber: line.lineNumber, externalPoId: po.id, mark: line.mark || null, description: line.description, panels: line.panels,
          })) });
          await tx.warehouseStock.createMany({ data: additions.map((line) => ({
            lineNumber: line.lineNumber, expectedParts: byLine.get(line.lineNumber)!,
            // A manually confirmed count is never recalculated by a later import.
            version: line.needsReview || line.expectedParts !== byLine.get(line.lineNumber) ? 1 : 0,
          })) });
        }
        for (const line of updates) {
          await tx.factoryUnit.update({ where: { lineNumber: line.lineNumber }, data: {
            mark: line.mark || null, description: line.description, panels: line.panels,
          } });
          await tx.warehouseStock.upsert({ where: { lineNumber: line.lineNumber },
            create: { lineNumber: line.lineNumber, expectedParts: byLine.get(line.lineNumber)!, version: 1 },
            update: { expectedParts: byLine.get(line.lineNumber)!, version: { increment: 1 } },
          });
        }
        await tx.eventLog.create({ data: {
          action: data.po ? 'UPDATE' : 'CREATE', entityType: 'FactoryPo', entityId: po.id, userId: actor.id,
          message: `External PO ${document.poNumber} imported: ${additions.length} new units; ${updates.length} reviewed updates.`,
        } });
        return { addedUnits: additions.length, linkedUnits: document.lines.length, unchanged: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code))
        throw new ConflictException('This PO or its factory lines changed during import. Preview the file again.');
      throw error;
    }
  }
}

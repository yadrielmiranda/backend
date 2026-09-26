import { assertMaterialReadyForFactory } from '@/estimates/material-revisions/material-revision-policy';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { expectedPhysicalParts } from '@/warehouse/warehouse-parts';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@/auth/types/auth-user.type';
import { calculateMaterialFinancials } from '../order-material-financials';
import {
  FactoryAssignment,
  FactoryDocument,
  LocalFactoryPiece,
  matchingIssues,
  matchFactoryLines,
  parseFactoryDocument,
  MAX_FACTORY_LINES,
} from './factory-import-matching';

const pieceInclude = {
  prod: true,
  bran: true,
  syst: true,
  conf: true,
  fColor: true,
  activeOption: true,
  factoryUnits: { orderBy: { lineNumber: 'asc' as const } },
} satisfies Prisma.PieceInclude;
type SourcePiece = Prisma.PieceGetPayload<{ include: typeof pieceInclude }>;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dimension = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);

function localPiece(piece: SourcePiece): LocalFactoryPiece {
  const dimensions = [
    'width',
    'height',
    'heightLeft',
    'heightRight',
    'legHeight',
    'sashHeight',
    'windowHeight',
    'doorWidth',
    'doorHeight',
    'leftSideliteWidth',
    'rightSideliteWidth',
  ] as const;
  const matchKey = hash([
    piece.idBrand,
    piece.idProd,
    piece.idSyst,
    piece.idConf,
    piece.idFC,
    piece.idCryst,
    piece.idTint,
    piece.idPrivacy,
    piece.idCoat,
    piece.idActiveOption,
    piece.idPreparationOption,
    piece.idSillOption,
    piece.idReinforcementOption,
    piece.screen,
    piece.highBottom,
    piece.leftPanels,
    piece.rightPanels,
    piece.panelCount,
    piece.horizontalHeights,
    ...dimensions.map((key) => piece[key]?.toString() ?? null),
  ]);
  return {
    id: piece.id,
    panelCount: piece.panelCount,
    fixedPanelCount: piece.conf.fixedPanelCount,
    mark: piece.mark,
    qty: piece.qty,
    brand: piece.bran.name,
    product: piece.prod.name,
    family:
      piece.prod.kind === 'LINEAR_MATERIAL'
        ? 'LINEAR_MATERIAL'
        : piece.prod.diagramFamily,
    system: piece.syst.name,
    configuration: piece.conf.conf,
    frameColor: piece.fColor.color,
    width: dimension(piece.width),
    height: dimension(piece.height),
    active: piece.activeOption?.name ?? '',
    complexDimensions: dimensions
      .slice(2)
      .some((key) => piece[key] !== null && Number(piece[key]) !== 0),
    matchKey,
    lineNumbers: piece.factoryUnits.map((unit) => unit.lineNumber),
  };
}
const publicPiece = ({ matchKey: _key, ...piece }: LocalFactoryPiece) => piece;

@Injectable()
export class FactoryImportService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthUser) {
    if (actor.role?.name !== 'admin')
      throw new ForbiddenException(
        'Only administrators can import factory orders.',
      );
  }

  private async load(db: Prisma.TransactionClient, orderId: number) {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        idEst: true,
        poNumber: true,
        rateReal: true,
        saleSubtotal: true,
        updatedAt: true,
        statusId: true,
        estimate: { select: { name: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found.');
    const sources = await db.piece.findMany({
      where: { idEst: order.idEst },
      include: pieceInclude,
      orderBy: { id: 'asc' },
    });
    const pieces = sources.map(localPiece);
    return {
      order,
      pieces,
      version: hash({
        order,
        pieces,
        updated: sources.map((piece) => piece.updatedAt),
      }),
    };
  }

  private context(data: Awaited<ReturnType<FactoryImportService['load']>>) {
    return {
      order: {
        id: data.order.id,
        number: data.order.number,
        name: data.order.estimate.name,
        poNumber: data.order.poNumber,
        factoryCost: data.order.rateReal?.toString() ?? null,
      },
      pieces: data.pieces.map(publicPiece),
      expectedUnits: data.pieces.reduce((sum, piece) => sum + piece.qty, 0),
      linkedUnits: data.pieces.reduce(
        (sum, piece) => sum + piece.lineNumbers.length,
        0,
      ),
    };
  }

  async get(orderId: number, actor: AuthUser) {
    this.assertAdmin(actor);
    return this.context(await this.load(this.prisma, orderId));
  }

  private async validateDocument(
    db: Prisma.TransactionClient,
    data: Awaited<ReturnType<FactoryImportService['load']>>,
    document: FactoryDocument,
  ) {
    const usedPo = await db.order.findUnique({
      where: { poNumber: document.poNumber },
      select: { id: true },
    });
    if (usedPo && usedPo.id !== data.order.id)
      throw new ConflictException(
        'This factory PO is already associated with another order.',
      );
    const existing = data.pieces.flatMap((piece) => piece.lineNumbers);
    if (existing.length && data.order.poNumber !== document.poNumber) {
      throw new ConflictException(
        'This order already has imported units for a different PO. Its factory PO cannot be replaced.',
      );
    }
    const incoming = new Set(document.lines.map((line) => line.lineNumber));
    if (existing.some((number) => !incoming.has(number))) {
      throw new ConflictException(
        'This file omits previously imported factory lines. Export the complete PO; existing links are preserved.',
      );
    }
    const linked = await db.factoryUnit.findMany({
      where: { lineNumber: { in: [...incoming] } },
      include: { piece: { select: { idEst: true } } },
    });
    const conflict = linked.find(
      (unit) => unit.piece.idEst !== data.order.idEst,
    );
    if (conflict)
      throw new ConflictException(
        `Factory line ${conflict.lineNumber} is already linked to another order.`,
      );
  }

  async preview(orderId: number, file: Buffer | undefined, actor: AuthUser) {
    this.assertAdmin(actor);
    const document = parseFactoryDocument(file);
    const data = await this.load(this.prisma, orderId);
    await assertMaterialReadyForFactory(this.prisma, data.order.idEst);
    await this.validateDocument(this.prisma, data, document);
    return {
      ...this.context(data),
      document: {
        poNumber: document.poNumber,
        factoryCost: document.factoryCost,
        orderName: document.orderName,
      },
      revision: hash([data.version, document]),
      lines: matchFactoryLines(document, data.pieces),
    };
  }

  async confirm(
    orderId: number,
    file: Buffer | undefined,
    fields: { revision?: string; assignments?: string; reviewed?: string },
    actor: AuthUser,
  ) {
    this.assertAdmin(actor);
    const document = parseFactoryDocument(file);
    if (!fields.revision || !/^[a-f0-9]{64}$/.test(fields.revision))
      throw new BadRequestException('Preview the file before importing it.');
    let assignments: FactoryAssignment[];
    try {
      const raw: unknown = JSON.parse(fields.assignments ?? '');
      if (
        !Array.isArray(raw) ||
        raw.length > MAX_FACTORY_LINES ||
        raw.some(
          (value) =>
            !value ||
            typeof value !== 'object' ||
            typeof value.lineNumber !== 'string' ||
            !Number.isSafeInteger(value.pieceId) ||
            value.pieceId <= 0,
        )
      )
        throw new Error();
      assignments = raw.map((value) => ({
        lineNumber: value.lineNumber,
        pieceId: value.pieceId,
      }));
    } catch {
      throw new BadRequestException('Select a piece for every factory line.');
    }
    const byLine = new Map(
      assignments.map((value) => [value.lineNumber, value.pieceId]),
    );
    if (
      assignments.length !== document.lines.length ||
      byLine.size !== assignments.length ||
      document.lines.some((line) => !byLine.has(line.lineNumber))
    ) {
      throw new BadRequestException(
        'Each factory line must be assigned exactly once.',
      );
    }
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const order = await tx.order.findUnique({ where: { id: orderId }, select: { idEst: true } });
          if (!order) throw new NotFoundException('Order not found.');
          await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${order.idEst} FOR UPDATE`;
          await assertMaterialReadyForFactory(tx, order.idEst);
          const data = await this.load(tx, orderId);
          if (fields.revision !== hash([data.version, document]))
            throw new ConflictException(
              'The order or its pieces changed. Preview the file again before importing.',
            );
          await this.validateDocument(tx, data, document);
          const piecesById = new Map(
            data.pieces.map((piece) => [piece.id, piece]),
          );
          const existing = new Map(
            data.pieces.flatMap((piece) =>
              piece.lineNumbers.map((line) => [line, piece.id] as const),
            ),
          );
          const counts = new Map<number, number>();
          const additions: FactoryAssignment[] = [];
          let needsReview = false;
          for (const line of document.lines) {
            const pieceId = byLine.get(line.lineNumber)!;
            const piece = piecesById.get(pieceId);
            if (!piece)
              throw new BadRequestException(
                'Every selected piece must belong to this order.',
              );
            if (
              existing.has(line.lineNumber) &&
              existing.get(line.lineNumber) !== pieceId
            )
              throw new ConflictException(
                'An imported factory line cannot be reassigned.',
              );
            const count = (counts.get(pieceId) ?? 0) + 1;
            if (count > piece.qty)
              throw new BadRequestException(
                `Piece ${piece.mark || '#' + piece.id} exceeds its quantity of ${piece.qty}.`,
              );
            counts.set(pieceId, count);
            if (matchingIssues(line, piece).length) needsReview = true;
            if (!existing.has(line.lineNumber))
              additions.push({ lineNumber: line.lineNumber, pieceId });
          }
          if (
            data.pieces.some(
              (piece) => (counts.get(piece.id) ?? 0) !== piece.qty,
            )
          )
            needsReview = true;
          if (needsReview && fields.reviewed !== 'true')
            throw new BadRequestException(
              'Review the manual matches and quantity differences before importing.',
            );
          if (additions.length)
            await tx.factoryUnit.createMany({ data: additions });
          // Solo se guarda el total de partes físicas; no se duplica la ficha ni el JSON.
          const stockRows = document.lines.map((line) => ({
            lineNumber: line.lineNumber,
            expectedParts: expectedPhysicalParts(
              piecesById.get(byLine.get(line.lineNumber)!)!,
              line.panels,
            ),
          }));
          const initialized = await tx.warehouseStock.createMany({
            data: stockRows,
            skipDuplicates: true,
          });
          let initializedParts = 0;
          const groups = new Map<number | null, string[]>();
          for (const row of stockRows) {
            groups.set(row.expectedParts, [
              ...(groups.get(row.expectedParts) ?? []),
              row.lineNumber,
            ]);
          }
          // Una reimportación corrige cantidades automáticas sin actividad de almacén.
          // Se conservan los conteos revisados, las existencias y todo su historial.
          for (const [expectedParts, lineNumbers] of groups) {
            const updated = await tx.warehouseStock.updateMany({
              where: {
                lineNumber: { in: lineNumbers },
                version: 0,
                inTransit: 0,
                onHand: 0,
                released: 0,
                movements: { none: {} },
                countLines: { none: {} },
                ...(expectedParts === null
                  ? { expectedParts: { not: null } }
                  : {
                      OR: [
                        { expectedParts: null },
                        { expectedParts: { not: expectedParts } },
                      ],
                    }),
              },
              data: { expectedParts },
            });
            initializedParts += updated.count;
          }
          // El objetivo de una recogida activa es una instantánea: se revierte
          // toda la importación si cambia sus líneas o cantidades pendientes.
          if ((initialized.count > 0 || initializedParts > 0 || additions.length > 0) &&
              await tx.factoryPickupRunOrder.findFirst({ where: { orderId, activeSlot: 1 } }))
            throw new ConflictException(
              'Finish the active factory pickup before importing changes to its units or expected parts. Then preview the file again.',
            );
          const cost = new Prisma.Decimal(document.factoryCost);
          const changed =
            initialized.count > 0 ||
            initializedParts > 0 ||
            additions.length > 0 ||
            data.order.poNumber !== document.poNumber ||
            !data.order.rateReal?.eq(cost);
          if (changed) {
            const financials = calculateMaterialFinancials({
              saleSubtotal: data.order.saleSubtotal.toString(),
              factoryRate: document.factoryCost,
            });
            await tx.order.update({
              where: { id: orderId },
              data: {
                poNumber: document.poNumber,
                rateReal: cost,
                netProfitReal: new Prisma.Decimal(
                  financials.totalProfit.toFixed(2),
                ),
              },
            });
            // Auditoría mínima y atómica: nunca incluye el JSON ni fichas duplicadas.
            await tx.eventLog.create({
              data: {
                action: 'UPDATE',
                entityType: 'Order',
                entityId: orderId,
                userId: actor.id,
                message: `Factory PO ${document.poNumber} imported: ${additions.length} new unit links; factory cost ${document.factoryCost} USD.`,
              },
            });
          }
          return {
            addedUnits: additions.length,
            linkedUnits: assignments.length,
            unchanged: !changed,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException(
          'This PO or its factory lines changed during import. Preview the file again.',
        );
      }
      throw error;
    }
  }
}

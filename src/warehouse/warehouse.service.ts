import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WarehouseMovementType } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { assertScheduleMilestone } from '@/payment-plans/payment-schedule';
import {
  barcodeLine,
  expectedPhysicalParts,
  assertBalances,
} from './warehouse-parts';
import { assertWarehouseRelease } from './warehouse-release';
import { assertCompanyFactoryCollection } from './factory-fulfillment';
import { installationDestination, installationDestinationSelect } from './warehouse-installation';
import {
  WarehouseScanDto,
  WarehouseRequestDto,
  WarehousePartsDto,
  WarehouseCountScanDto,
  WarehouseCountCloseDto,
  WarehouseCountStartDto,
  WarehouseReceiptDto,
  WarehouseInstallationDeliveryDto,
  WarehouseTransferDto,
  WarehouseStoreCreateDto,
  WarehouseStoreUpdateDto,
  FactoryPickupRunCreateDto,
  FactoryPickupAssignmentsDto,
  FactoryPickupRunCycleDto,
  FactoryPickupRunScanDto,
  FactoryPickupRunFinishDto,
} from './warehouse.dto';

const actorSelect = {
  id: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;
const storeSelect = { id: true, name: true, isActive: true } satisfies Prisma.WarehouseStoreSelect;
const stockInclude = {
  storeBalances: { include: { store: { select: storeSelect } } },
  unit: {
    include: {
      piece: {
        select: {
          id: true,
          idEst: true,
          mark: true,
          panelCount: true,
          prod: { select: { name: true, kind: true, diagramFamily: true } },
          conf: { select: { conf: true, fixedPanelCount: true } },
          syst: { select: { name: true } },
          estim: {
            select: {
              name: true,
              customerFirstName: true,
              customerLastName: true,
              user: { select: actorSelect },
              order: { select: { id: true, number: true, poNumber: true, fulfillmentMethod: true } },
              installationJob: { select: installationDestinationSelect },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.WarehouseStockInclude;
const movementInclude = {
  fromStore: { select: storeSelect },
  toStore: { select: storeSelect },
  actor: { select: actorSelect },
  reversal: { select: { id: true } },
} satisfies Prisma.WarehouseMovementInclude;
type Stock = Prisma.WarehouseStockGetPayload<{ include: typeof stockInclude }>;
type Movement = Prisma.WarehouseMovementGetPayload<{
  include: typeof movementInclude;
}>;
type Tx = Prisma.TransactionClient;
type Query = Record<string, string | undefined>;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const name = (user: { firstName: string; lastName: string }) =>
  `${user.firstName} ${user.lastName}`.trim();

function parts(stock: Stock) {
  const p = stock.unit.piece;
  return (
    stock.expectedParts ??
    expectedPhysicalParts({
      family:
        p.prod.kind === 'LINEAR_MATERIAL'
          ? 'LINEAR_MATERIAL'
          : p.prod.diagramFamily,
      panelCount: p.panelCount,
      fixedPanelCount: p.conf.fixedPanelCount,
    })
  );
}
function presentStock(stock: Stock) {
  const p = stock.unit.piece,
    e = p.estim,
    expected = parts(stock);
  return {
    lineNumber: stock.lineNumber,
    barcode: `I${stock.lineNumber}`,
    pieceId: p.id,
    mark: p.mark,
    product: p.prod.name,
    system: p.syst.name,
    configuration: p.conf.conf,
    orderId: e.order?.id ?? null,
    orderNumber: e.order?.number ?? '',
    poNumber: e.order?.poNumber ?? '',
    customer:
      [e.customerFirstName, e.customerLastName].filter(Boolean).join(' ') ||
      name(e.user),
    project: e.name,
    installation: ['INSTALLATION_DELIVERY', 'COMPANY_DELIVERY'].includes(e.order?.fulfillmentMethod ?? '')
      ? installationDestination(e.installationJob) : null,
    expectedParts: expected,
    inTransit: stock.inTransit,
    onHand: stock.onHand,
    unassigned: stock.unassigned,
    stores: stock.storeBalances
      .filter((b) => b.onHand > 0)
      .map((b) => ({ ...b.store, onHand: b.onHand }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    released: stock.released,
    pending:
      expected === null
        ? null
        : expected - stock.inTransit - stock.onHand - stock.released,
    version: stock.version,
    updatedAt: stock.updatedAt,
    state:
      expected === null
        ? 'NEEDS_PARTS'
        : stock.onHand === expected
          ? 'COMPLETE'
          : stock.onHand > 0
            ? 'PARTIAL'
            : stock.inTransit > 0
              ? 'IN_TRANSIT'
              : stock.released === expected
                ? 'RELEASED'
                : 'PENDING',
  };
}
function presentMovement(m: Movement) {
  return {
    id: m.id,
    lineNumber: m.lineNumber,
    type: m.type,
    quantity: m.quantity,
    fromStore: m.fromStore,
    toStore: m.toStore,
    installation: m.installationJobId == null ? null : {
      id: m.installationJobId, address: m.installationAddress ?? '',
    },
    transitDelta: m.transitDelta,
    onHandDelta: m.onHandDelta,
    releasedDelta: m.releasedDelta,
    transitAfter: m.transitAfter,
    onHandAfter: m.onHandAfter,
    releasedAfter: m.releasedAfter,
    expectedPartsBefore: m.expectedPartsBefore,
    expectedPartsAfter: m.expectedPartsAfter,
    actor: name(m.actor),
    actorId: m.actorId,
    reason: m.reason,
    reversalOfId: m.reversalOfId,
    reversed: Boolean(m.reversal),
    countId: m.countId,
    countDelta: m.countDelta,
    createdAt: m.createdAt,
  };
}
function storeQuantity(stock: Stock, storeId: number | null): number {
  return storeId === null
    ? stock.unassigned
    : stock.storeBalances.find((b) => b.storeId === storeId)?.onHand ?? 0;
}
function countQuantity(
  stock: Stock,
  count: { scope: string; storeId: number | null },
) {
  return count.scope === 'ALL'
    ? stock.onHand
    : storeQuantity(stock, count.storeId);
}
function storeName(value: string) {
  const clean = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!clean || clean.length > 80 || clean.toLowerCase() === 'unassigned')
    throw new BadRequestException('Enter a store name (1–80 characters). Unassigned is reserved.');
  return clean;
}
function countRevision(
  id: number,
  lines: Array<{
    lineNumber: string;
    expected: number;
    counted: number;
    stockVersion: number;
  }>,
) {
  return hash([
    id,
    [...lines]
      .sort((a, b) => a.lineNumber.localeCompare(b.lineNumber))
      .map((l) => [l.lineNumber, l.expected, l.counted, l.stockVersion]),
  ]);
}
function paging(query: Query) {
  const page = Number(query.page ?? 1),
    pageSize = Number(query.pageSize ?? 50);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new BadRequestException('Invalid page.');
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
function stockSearch(
  search: string | undefined,
): Prisma.WarehouseStockWhereInput {
  if (search !== undefined && typeof search !== 'string')
    throw new BadRequestException('Invalid search.');
  const q = search?.trim() ?? '';
  if (q.length > 150)
    throw new BadRequestException('Search must be 150 characters or fewer.');
  if (!q) return {};
  const contains = { contains: q };
  return {
    OR: [
      { lineNumber: { contains: q.replace(/^I(?=\d)/i, '') } },
      {
        unit: {
          piece: {
            OR: [
              { mark: contains },
              { prod: { name: contains } },
              {
                estim: {
                  OR: [
                    { name: contains },
                    { customerFirstName: contains },
                    { customerLastName: contains },
                    {
                      user: {
                        OR: [{ firstName: contains }, { lastName: contains }],
                      },
                    },
                    {
                      order: {
                        OR: [{ number: contains }, { poNumber: contains }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  };
}

function pickupPoNumber(value: unknown) {
  if (typeof value !== 'string')
    throw new BadRequestException('Enter a factory PO number.');
  const clean = value.trim();
  if (!clean || clean.length > 50)
    throw new BadRequestException('Enter a factory PO number (1–50 characters).');
  return clean;
}

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  private staff(actor: AuthUser, admin = false) {
    if (
      !actor ||
      (admin
        ? actor.role?.name !== 'admin'
        : !['admin', 'operator'].includes(actor.role?.name ?? ''))
    )
      throw new ForbiddenException(
        'Warehouse is available to authorized staff only.',
      );
  }
  private receivingStaff(actor: AuthUser) {
    if (actor?.role?.name !== 'technician') this.staff(actor);
  }

  private technician(actor: AuthUser) {
    if (actor?.role?.name !== 'technician')
      throw new ForbiddenException('Use an internal technician account.');
  }
  private factoryPickupStaff(actor: AuthUser) {
    if (actor?.role?.name === 'technician') return;
    this.staff(actor, true);
  }

  private pickupAccess(actor: AuthUser): Prisma.FactoryPickupRunWhereInput {
    return actor.role.name === 'admin' ? {} : { technicians: { some: { technicianId: actor.id } } };
  }

  // Proyección mínima: sin cliente, precios, enlaces a órdenes o inventario general.
  private technicianStock(stock: ReturnType<typeof presentStock>) {
    return {
      lineNumber: stock.lineNumber, barcode: stock.barcode, mark: stock.mark,
      product: stock.product, system: stock.system, configuration: stock.configuration,
      orderNumber: stock.orderNumber, poNumber: stock.poNumber,
      expectedParts: stock.expectedParts, inTransit: stock.inTransit,
      onHand: stock.onHand, pending: stock.pending, version: stock.version,
      installation: stock.installation,
    };
  }

  async technicianState(actor: AuthUser) {
    this.technician(actor);
    return this.prisma.$transaction(async (tx) => {
      const stores = await tx.warehouseStore.findMany({
        where: { isActive: true }, select: storeSelect, orderBy: { name: 'asc' },
      });
      const count = await tx.warehouseCount.findUnique({ where: { activeSlot: 1 }, select: { id: true } });
      const where = { ...this.pickupAccess(actor), status: 'ACTIVE' as const };
      const activePickup = await tx.factoryPickupRun.findFirst({
        where, orderBy: { id: 'asc' },
        select: { id: true, startedAt: true },
      });
      const activePickupCount = await tx.factoryPickupRun.count({ where });
      return { stores, countOpen: Boolean(count), activePickup, activePickupCount };
    });
  }

  async technicianPending(query: Query, actor: AuthUser) {
    this.technician(actor);
    const p = paging(query);
    // El cliente no puede cambiar la vista ni pedir existencias o salidas.
    const where: Prisma.WarehouseStockWhereInput = { ...stockSearch(query.search), inTransit: { gt: 0 } };
    return this.prisma.$transaction(async (tx) => ({
      items: (await tx.warehouseStock.findMany({
        where, include: stockInclude, orderBy: { lineNumber: 'asc' }, skip: p.skip, take: p.take,
      })).map((row) => this.technicianStock(presentStock(row))),
      total: await tx.warehouseStock.count({ where }), page: p.page, pageSize: p.pageSize,
    }));
  }

  async technicianScan(dto: WarehouseScanDto, actor: AuthUser) {
    this.technician(actor);
    if (dto.action === 'COLLECT')
      throw new BadRequestException(
        'Start or resume a factory pickup before collecting parts.',
      );
    const result = await this.scan(dto, actor);
    return {
      stock: this.technicianStock(result.stock), replayed: result.replayed,
      movement: {
        id: result.movement.id, type: result.movement.type, quantity: result.movement.quantity,
        createdAt: result.movement.createdAt, toStore: result.movement.toStore,
      },
    };
  }

  private async pickupOrderSnapshot(
    tx: Tx,
    poNumberValue: string,
    currentRunId?: number,
  ) {
    const poNumber = pickupPoNumber(poNumberValue);
    const order = await tx.order.findUnique({
      where: { poNumber },
      select: { id: true, number: true, poNumber: true, fulfillmentMethod: true },
    });
    if (!order?.poNumber)
      throw new NotFoundException('PO not found. Check the factory PO number.');
    assertCompanyFactoryCollection(order);

    const active = await tx.factoryPickupRunOrder.findFirst({
      where: { orderId: order.id, activeSlot: 1 },
      select: { pickupRunId: true },
    });
    if (active && active.pickupRunId !== currentRunId)
      throw new ConflictException(
        'This PO is already included in another active factory pickup.',
      );

    const stocks = await tx.warehouseStock.findMany({
      where: {
        unit: { piece: { estim: { order: { id: order.id } } } },
      },
      include: stockInclude,
      orderBy: { lineNumber: 'asc' },
    });
    if (!stocks.length)
      throw new BadRequestException(
        'This PO has no factory units. Import its factory JSON first.',
      );

    const lines = stocks.map((stock) => {
      const expected = parts(stock);
      if (!expected)
        throw new BadRequestException(
          `Expected physical parts are not configured for Line ${stock.lineNumber}.`,
        );
      return {
        stock,
        targetParts: Math.max(
          0,
          expected - stock.inTransit - stock.onHand - stock.released,
        ),
      };
    }).filter((line) => line.targetParts > 0);

    if (!lines.length)
      throw new BadRequestException('This PO has already been fully collected.');

    return { order, lines };
  }

  private async addPickupOrder(
    tx: Tx,
    pickupRunId: number,
    poNumber: string,
    addedDuringPickup: boolean,
  ) {
    const snapshot = await this.pickupOrderSnapshot(tx, poNumber, pickupRunId);
    const existing = await tx.factoryPickupRunOrder.findUnique({
      where: {
        pickupRunId_orderId: {
          pickupRunId,
          orderId: snapshot.order.id,
        },
      },
    });
    if (existing) return snapshot;

    await tx.factoryPickupRunOrder.create({
      data: {
        pickupRunId,
        orderId: snapshot.order.id,
        addedDuringPickup,
      },
    });
    await tx.factoryPickupRunLine.createMany({
      data: snapshot.lines.map(({ stock, targetParts }) => ({
        pickupRunId,
        lineNumber: stock.lineNumber,
        targetParts,
      })),
    });
    return snapshot;
  }

  private async pickupRunSummary(
    tx: Tx,
    pickupRunId: number,
    actor: AuthUser,
  ) {
    const run = await tx.factoryPickupRun.findFirst({
      where: { id: pickupRunId, ...this.pickupAccess(actor) },
      select: {
        id: true,
        createdBy: { select: actorSelect },
        closedBy: { select: actorSelect },
        technicians: { select: { technician: { select: actorSelect } }, orderBy: { technicianId: 'asc' } },
        status: true,
        cycle: true,
        events: { include: { actor: { select: actorSelect } }, orderBy: { id: 'asc' } },
        startedAt: true,
        finishedAt: true,
        partialReason: true,
        note: true,
      },
    });
    if (!run)
      throw new NotFoundException('Factory pickup not found.');

    const [orders, lines, movements] = await Promise.all([
      tx.factoryPickupRunOrder.findMany({
        where: { pickupRunId },
        include: { order: { select: { id: true, number: true, poNumber: true } } },
        orderBy: { addedAt: 'asc' },
      }),
      tx.factoryPickupRunLine.findMany({
        where: { pickupRunId },
        include: { stock: { include: stockInclude } },
        orderBy: { lineNumber: 'asc' },
      }),
      tx.warehouseMovement.findMany({
        // Una lectura COLLECT revertida deja de contar para el progreso del pickup.
        where: { pickupRunId, type: 'COLLECT', reversal: null },
        select: { lineNumber: true, quantity: true, actor: { select: actorSelect }, createdAt: true },
        orderBy: { id: 'asc' },
      }),
    ]);

    const collectedByLine = new Map<string, number>();
    for (const movement of movements)
      collectedByLine.set(
        movement.lineNumber,
        (collectedByLine.get(movement.lineNumber) ?? 0) + movement.quantity,
      );

    const presentedLines = lines.map((line) => {
      const unit = this.technicianStock(presentStock(line.stock));
      const collected = Math.min(
        line.targetParts,
        collectedByLine.get(line.lineNumber) ?? 0,
      );
      const remaining = Math.max(0, line.targetParts - collected);
      return {
        ...unit,
        orderId: line.stock.unit.piece.estim.order?.id ?? null,
        targetParts: line.targetParts,
        collected,
        remaining,
        collectionState:
          remaining === 0
            ? 'COMPLETE'
            : collected > 0
              ? 'PARTIAL'
              : 'PENDING',
      };
    });

    const orderItems = orders.map((entry) => {
      const orderLines = presentedLines.filter(
        (line) => line.orderId === entry.orderId,
      );
      const expectedParts = orderLines.reduce(
        (sum, line) => sum + line.targetParts,
        0,
      );
      const collectedParts = orderLines.reduce(
        (sum, line) => sum + line.collected,
        0,
      );
      return {
        orderId: entry.orderId,
        orderNumber: entry.order.number,
        poNumber: entry.order.poNumber ?? '',
        addedDuringPickup: entry.addedDuringPickup,
        addedAt: entry.addedAt,
        pieces: orderLines.length,
        expectedParts,
        collectedParts,
        remainingParts: Math.max(0, expectedParts - collectedParts),
      };
    });
    const expectedParts = presentedLines.reduce(
      (sum, line) => sum + line.targetParts,
      0,
    );
    const collectedParts = presentedLines.reduce(
      (sum, line) => sum + line.collected,
      0,
    );

    const collectors = new Map<number, { id: number; name: string; parts: number; firstScanAt: Date; lastScanAt: Date }>();
    for (const movement of movements) {
      const collector = collectors.get(movement.actor.id) ?? {
        id: movement.actor.id, name: name(movement.actor), parts: 0,
        firstScanAt: movement.createdAt, lastScanAt: movement.createdAt,
      };
      collector.parts += movement.quantity;
      collector.lastScanAt = movement.createdAt;
      collectors.set(collector.id, collector);
    }

    return {
      id: run.id,
      cycle: run.cycle,
      events: run.events.map((event) => ({
        id: event.id, status: event.status, cycle: event.cycle, createdAt: event.createdAt,
        actor: { id: event.actor.id, name: name(event.actor) }, partialReason: event.partialReason, note: event.note,
      })),
      createdBy: { id: run.createdBy.id, name: name(run.createdBy) },
      closedBy: run.closedBy ? { id: run.closedBy.id, name: name(run.closedBy) } : null,
      technicians: run.technicians.map(({ technician }) => ({ id: technician.id, name: name(technician) })),
      collectors: [...collectors.values()],
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      partialReason: run.partialReason,
      note: run.note,
      poCount: orders.length,
      expectedParts,
      collectedParts,
      remainingParts: Math.max(0, expectedParts - collectedParts),
      orders: orderItems,
      lines: presentedLines,
    };
  }

  async factoryPickupCurrent(actor: AuthUser) {
    this.factoryPickupStaff(actor);
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.factoryPickupRun.findFirst({
        where: { ...this.pickupAccess(actor), status: 'ACTIVE' },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      return run ? this.pickupRunSummary(tx, run.id, actor) : null;
    });
  }

  async factoryPickups(query: Query, actor: AuthUser) {
    this.factoryPickupStaff(actor);
    const p = paging(query);
    if (p.pageSize > 50) throw new BadRequestException('Pickup pages are limited to 50 items.');
    const where: Prisma.FactoryPickupRunWhereInput = {
      ...this.pickupAccess(actor),
      status: query.status === 'CLOSED' ? { in: ['COMPLETED', 'PARTIAL'] } : 'ACTIVE',
    };
    return this.prisma.$transaction(async (tx) => {
      const runs = await tx.factoryPickupRun.findMany({
        where, select: { id: true }, orderBy: { id: 'desc' }, skip: p.skip, take: Math.min(p.take, 50),
      });
      const items = await Promise.all(runs.map(async (run) => {
        const { lines: _lines, ...summary } = await this.pickupRunSummary(tx, run.id, actor);
        return summary;
      }));
      return { items, total: await tx.factoryPickupRun.count({ where }), page: p.page, pageSize: Math.min(p.take, 50) };
    });
  }

  async factoryPickup(id: number, actor: AuthUser) {
    this.factoryPickupStaff(actor);
    return this.prisma.$transaction((tx) => this.pickupRunSummary(tx, id, actor));
  }

  async factoryPickupTechnicians(actor: AuthUser) {
    this.staff(actor, true);
    const technicians = await this.prisma.user.findMany({
      where: { role: { name: 'technician' }, isActive: true, deletedAt: null },
      select: actorSelect, orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
    });
    return technicians.map((user) => ({ id: user.id, name: name(user) }));
  }

  private async validatePickupTechnicians(tx: Tx, ids: number[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)
      throw new BadRequestException('Assign between 1 and 50 different technicians.');
    const count = await tx.user.count({
      where: { id: { in: ids }, role: { name: 'technician' }, isActive: true, deletedAt: null },
    });
    if (count !== ids.length)
      throw new BadRequestException('Assign active technician accounts only. Refresh the technician list.');
  }

  async assignFactoryPickup(id: number, dto: FactoryPickupAssignmentsDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.transaction(async (tx) => {
      await this.lockPickupRun(tx, id, actor);
      await this.validatePickupTechnicians(tx, dto.technicianIds);
      await tx.factoryPickupRunTechnician.deleteMany({ where: { pickupRunId: id } });
      await tx.factoryPickupRunTechnician.createMany({
        data: dto.technicianIds.map((technicianId) => ({ pickupRunId: id, technicianId })),
      });
      return this.pickupRunSummary(tx, id, actor);
    });
  }

  async factoryPickupPo(poNumber: string, actor: AuthUser) {
    this.staff(actor, true);
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.pickupOrderSnapshot(tx, poNumber);
      return {
        orderId: snapshot.order.id,
        orderNumber: snapshot.order.number,
        poNumber: snapshot.order.poNumber!,
        pieces: snapshot.lines.length,
        parts: snapshot.lines.reduce((sum, line) => sum + line.targetParts, 0),
      };
    });
  }

  async startFactoryPickup(dto: FactoryPickupRunCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    if (!Array.isArray(dto.poNumbers) || !dto.poNumbers.length || dto.poNumbers.length > 50)
      throw new BadRequestException('Add between 1 and 50 POs to this pickup.');
    const poNumbers = dto.poNumbers.map(pickupPoNumber);
    if (new Set(poNumbers.map((po) => po.toLocaleLowerCase())).size !== poNumbers.length)
      throw new BadRequestException('Add each PO only once.');

    return this.transaction(async (tx) => {
      await this.noCount(tx);
      await this.validatePickupTechnicians(tx, dto.technicianIds);
      const run = await tx.factoryPickupRun.create({
        data: { createdById: actor.id },
        select: { id: true },
      });
      await tx.factoryPickupRunTechnician.createMany({
        data: dto.technicianIds.map((technicianId) => ({ pickupRunId: run.id, technicianId })),
      });
      for (const poNumber of poNumbers)
        await this.addPickupOrder(tx, run.id, poNumber, false);
      return this.pickupRunSummary(tx, run.id, actor);
    }, 60000);
  }

  private async lockPickupRun(tx: Tx, pickupRunId: number, actor: AuthUser, requireActive = true) {
    await tx.$queryRaw`SELECT id FROM factory_pickup_runs WHERE id = ${pickupRunId} FOR UPDATE`;
    const run = await tx.factoryPickupRun.findFirst({ where: { id: pickupRunId, ...this.pickupAccess(actor) } });
    if (!run)
      throw new NotFoundException('Factory pickup not found.');
    if (requireActive && (run.status !== 'ACTIVE' || run.activeSlot !== 1))
      throw new ConflictException('This factory pickup is already closed.');
    return run;
  }

  async factoryPickupScan(
    pickupRunId: number,
    dto: FactoryPickupRunScanDto,
    actor: AuthUser,
  ) {
    this.factoryPickupStaff(actor);
    const lineNumber = barcodeLine(dto.barcode);
    const requestHash = hash([
      actor.id,
      'PICKUP_COLLECT',
      pickupRunId,
      lineNumber,
    ]);

    return this.transaction(async (tx) => {
      const run = await this.lockPickupRun(tx, pickupRunId, actor, false);
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay)
        return {
          kind: 'COLLECTED' as const,
          stock: this.technicianStock(replay.stock),
          movement: {
            id: replay.movement.id,
            type: replay.movement.type,
            quantity: replay.movement.quantity,
            createdAt: replay.movement.createdAt,
            toStore: replay.movement.toStore,
          },
          replayed: true,
          pickup: await this.pickupRunSummary(tx, pickupRunId, actor),
        };
      // Permite recuperar una respuesta perdida después del cierre, sin aceptar lecturas nuevas.
      if (run.status !== 'ACTIVE' || run.activeSlot !== 1)
        throw new ConflictException('This factory pickup is already closed.');
      await this.noCount(tx);
      const stock = await this.load(tx, lineNumber);
      const order = stock.unit.piece.estim.order!;
      assertCompanyFactoryCollection(order);
      const expected = parts(stock);
      if (!expected)
        throw new BadRequestException(
          `Expected physical parts are not configured for Line ${lineNumber}.`,
        );
      const globallyRemaining =
        expected - stock.inTransit - stock.onHand - stock.released;
      if (globallyRemaining <= 0)
        throw new BadRequestException(
          'All expected parts for this line have already been collected.',
        );

      let runOrder = await tx.factoryPickupRunOrder.findUnique({
        where: {
          pickupRunId_orderId: { pickupRunId, orderId: order.id },
        },
      });
      if (!runOrder && !dto.addPo) {
        const snapshot = await this.pickupOrderSnapshot(
          tx,
          order.poNumber ?? '',
          pickupRunId,
        );
        return {
          kind: 'PO_NOT_INCLUDED' as const,
          candidate: {
            orderId: order.id,
            orderNumber: order.number,
            poNumber: order.poNumber ?? '',
            pieces: snapshot.lines.length,
            parts: snapshot.lines.reduce(
              (sum, line) => sum + line.targetParts,
              0,
            ),
            lineNumber,
            barcode: `I${lineNumber}`,
            mark: stock.unit.piece.mark,
            product: stock.unit.piece.prod.name,
            system: stock.unit.piece.syst.name,
            configuration: stock.unit.piece.conf.conf,
          },
        };
      }
      if (!runOrder) {
        if (!order.poNumber)
          throw new BadRequestException('This order does not have a factory PO number.');
        await this.addPickupOrder(tx, pickupRunId, order.poNumber, true);
        runOrder = await tx.factoryPickupRunOrder.findUnique({
          where: {
            pickupRunId_orderId: { pickupRunId, orderId: order.id },
          },
        });
      }

      let runLine = await tx.factoryPickupRunLine.findUnique({
        where: {
          pickupRunId_lineNumber: { pickupRunId, lineNumber },
        },
      });
      if (!runLine) {
        runLine = await tx.factoryPickupRunLine.create({
          data: {
            pickupRunId,
            lineNumber,
            targetParts: globallyRemaining,
          },
        });
      }
      const collected = await tx.warehouseMovement.aggregate({
        where: { pickupRunId, lineNumber, type: 'COLLECT', reversal: null },
        _sum: { quantity: true },
      });
      if ((collected._sum.quantity ?? 0) >= runLine.targetParts)
        throw new BadRequestException(
          'All expected parts for this line have already been collected in this pickup.',
        );

      const result = await this.move(tx, stock, {
        type: 'COLLECT',
        actorId: actor.id,
        requestKey: dto.requestKey,
        requestHash,
        transitDelta: 1,
        quantity: 1,
        pickupRunId,
      });
      return {
        kind: 'COLLECTED' as const,
        stock: this.technicianStock(result.stock),
        movement: {
          id: result.movement.id,
          type: result.movement.type,
          quantity: result.movement.quantity,
          createdAt: result.movement.createdAt,
          toStore: result.movement.toStore,
        },
        replayed: result.replayed,
        pickup: await this.pickupRunSummary(tx, pickupRunId, actor),
      };
    }, 60000);
  }

  async finishFactoryPickup(
    pickupRunId: number,
    dto: FactoryPickupRunFinishDto,
    actor: AuthUser,
  ) {
    this.factoryPickupStaff(actor);
    return this.transaction(async (tx) => {
      const run = await this.lockPickupRun(tx, pickupRunId, actor, false);
      if (dto.cycle !== run.cycle)
        throw new ConflictException('This pickup was reopened. Refresh it before closing again.');
      const note = dto.note?.trim() || null;
      if (note && note.length > 500)
        throw new BadRequestException('Pickup note must be 500 characters or fewer.');
      // Un reintento recupera el cierre guardado, sin sobrescribirlo ni liberar otro PO.
      if (run.status !== 'ACTIVE') {
        const partialReason = run.status === 'PARTIAL' ? dto.partialReason ?? null : null;
        if (run.note !== note || run.partialReason !== partialReason)
          throw new ConflictException('This factory pickup was already closed with different details.');
        return this.pickupRunSummary(tx, pickupRunId, actor);
      }
      const summary = await this.pickupRunSummary(tx, pickupRunId, actor);
      const partial = summary.remainingParts > 0;
      if (partial && !dto.partialReason)
        throw new BadRequestException(
          'Choose why this pickup is being finished with parts remaining.',
        );
      await tx.factoryPickupRun.update({
        where: { id: pickupRunId },
        data: {
          status: partial ? 'PARTIAL' : 'COMPLETED',
          activeSlot: null,
          finishedAt: new Date(),
          closedById: actor.id,
          partialReason: partial ? dto.partialReason : null,
          note,
        },
      });
      await tx.factoryPickupRunOrder.updateMany({
        where: { pickupRunId },
        data: { activeSlot: null },
      });
      await tx.factoryPickupRunEvent.create({ data: {
        pickupRunId, actorId: actor.id, cycle: run.cycle,
        status: partial ? 'PARTIAL' : 'COMPLETED', partialReason: partial ? dto.partialReason : null, note,
      } });
      return this.pickupRunSummary(tx, pickupRunId, actor);
    });
  }

  async reopenFactoryPickup(id: number, dto: FactoryPickupRunCycleDto, actor: AuthUser) {
    this.staff(actor, true);
    return this.transaction(async (tx) => {
      const run = await this.lockPickupRun(tx, id, actor, false);
      // La repetición de una reapertura no crea otro ciclo ni afecta al trabajo posterior.
      if (run.status === 'ACTIVE' && run.cycle === dto.cycle + 1)
        return this.pickupRunSummary(tx, id, actor);
      if (run.status === 'ACTIVE' || run.cycle !== dto.cycle)
        throw new ConflictException('This pickup has changed. Refresh it before reopening.');
      await this.noCount(tx);
      const summary = await this.pickupRunSummary(tx, id, actor);
      const other = await tx.factoryPickupRunOrder.findFirst({
        where: { orderId: { in: summary.orders.map((order) => order.orderId) }, activeSlot: 1, pickupRunId: { not: id } },
        include: { order: { select: { poNumber: true } } },
      });
      if (other)
        throw new ConflictException(`PO ${other.order.poNumber} is already in active pickup #${other.pickupRunId}. Close that pickup before reopening this one.`);
      for (const line of summary.lines) {
        const stock = await this.load(tx, line.lineNumber);
        const available = (parts(stock) ?? 0) - stock.inTransit - stock.onHand - stock.released;
        if (line.remaining > Math.max(0, available))
          throw new ConflictException('Some remaining parts have already been collected or received outside this pickup. Create a new pickup for the parts still at the factory.');
      }
      await tx.factoryPickupRunOrder.updateMany({ where: { pickupRunId: id }, data: { activeSlot: 1 } });
      await tx.factoryPickupRun.update({ where: { id }, data: {
        status: 'ACTIVE', activeSlot: 1, cycle: { increment: 1 }, finishedAt: null,
        closedById: null, partialReason: null, note: null,
      } });
      await tx.factoryPickupRunEvent.create({ data: { pickupRunId: id, actorId: actor.id, cycle: run.cycle + 1, status: 'ACTIVE' } });
      return this.pickupRunSummary(tx, id, actor);
    });
  }

  private async transaction<T>(work: (tx: Tx) => Promise<T>, timeout = 20000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout,
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2034', 'P2002'].includes(e.code)
        ) {
          if (attempt < 2) continue;
          throw new ConflictException(
            'Warehouse changed during this operation. Retry the same reading.',
          );
        }
        throw e;
      }
    }
  }
  // El bloqueo del store impide desactivarlo mientras una operación recibe stock.
  private async lockStores(tx: Tx, ids: number[], activeIds: number[] = []) {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    for (const id of unique) {
      if (!Number.isSafeInteger(id) || id < 1)
        throw new BadRequestException('Choose a valid store.');
      await tx.$queryRaw`SELECT id FROM warehouse_stores WHERE id = ${id} FOR UPDATE`;
      const store = await tx.warehouseStore.findUnique({ where: { id } });
      if (!store) throw new NotFoundException('Store not found.');
      if (activeIds.includes(id) && !store.isActive)
        throw new ConflictException('This store is inactive. Choose an active store.');
    }
  }
  private async load(tx: Tx, lineNumber: string): Promise<Stock> {
    const stock = await tx.warehouseStock.findUnique({
      where: { lineNumber },
      include: stockInclude,
    });
    if (!stock)
      throw new NotFoundException(
        'Barcode not found. Import its factory JSON into the matching order first.',
      );
    if (!stock.unit.piece.estim.order)
      throw new BadRequestException(
        'This factory unit is not associated with an order.',
      );
    return stock;
  }
  private async noCount(tx: Tx) {
    const count = await tx.warehouseCount.findUnique({
      where: { activeSlot: 1 },
    });
    if (count)
      throw new ConflictException(
        `Physical count #${count.id} is open. Finish or cancel it before moving stock.`,
      );
  }
  private async replay(tx: Tx, requestKey: string, requestHash: string) {
    const movement = await tx.warehouseMovement.findUnique({
      where: { requestKey },
      include: movementInclude,
    });
    if (!movement) return null;
    if (movement.requestHash !== requestHash)
      throw new ConflictException(
        'This request identifier was already used for another operation.',
      );
    return {
      stock: presentStock(await this.load(tx, movement.lineNumber)),
      movement: presentMovement(movement),
      replayed: true,
    };
  }
  private async move(
    tx: Tx,
    stock: Stock,
    data: {
      type: WarehouseMovementType;
      actorId: number;
      requestKey: string;
      requestHash: string;
      transitDelta?: number;
      onHandDelta?: number;
      releasedDelta?: number;
      expectedParts?: number;
      reason?: string;
      reversalOfId?: number;
      countId?: number;
      quantity?: number;
      fromStoreId?: number | null;
      toStoreId?: number | null;
      pickupRunId?: number;
      installationJobId?: number | null;
      installationAddress?: string | null;
    },
  ) {
    const { transitDelta = 0, onHandDelta = 0, releasedDelta = 0,
      quantity = Math.max(Math.abs(transitDelta), Math.abs(onHandDelta), Math.abs(releasedDelta)),
      fromStoreId = null, toStoreId = null } = data;
    const next = {
      expectedParts: data.expectedParts ?? parts(stock),
      inTransit: stock.inTransit + transitDelta,
      onHand: stock.onHand + onHandDelta,
      released: stock.released + releasedDelta,
    };
    assertBalances(next);
    const assigned = stock.storeBalances.reduce((sum, b) => sum + b.onHand, 0);
    if (stock.unassigned < 0 || assigned + stock.unassigned !== stock.onHand)
      throw new ConflictException('Store balances do not match warehouse stock. Review this unit before moving it.');
    const changes = new Map<number, number>();
    if (fromStoreId !== null) changes.set(fromStoreId, -quantity);
    if (toStoreId !== null) changes.set(toStoreId, (changes.get(toStoreId) ?? 0) + quantity);
    const unassigned = stock.unassigned + onHandDelta
      - [...changes.values()].reduce((sum, delta) => sum + delta, 0);
    if (unassigned < 0)
      throw new BadRequestException('Not enough Unassigned parts. Choose the store that holds these parts; for a count, count the affected store separately.');
    for (const [storeId, delta] of changes) {
      if (storeQuantity(stock, storeId) + delta < 0)
        throw new BadRequestException('Not enough parts in the selected source store.');
    }
    const changed = await tx.warehouseStock.updateMany({
      where: { lineNumber: stock.lineNumber, version: stock.version },
      data: { ...next, unassigned, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new ConflictException(
        'This unit changed. Refresh it before trying again.',
      );
    for (const [storeId, delta] of changes) {
      if (delta === 0) continue;
      await tx.warehouseStoreStock.upsert({
        where: { lineNumber_storeId: { lineNumber: stock.lineNumber, storeId } },
        create: { lineNumber: stock.lineNumber, storeId, onHand: storeQuantity(stock, storeId) + delta },
        update: { onHand: { increment: delta } },
      });
    }
    const movement = await tx.warehouseMovement.create({
      data: {
        lineNumber: stock.lineNumber,
        quantity,
        fromStoreId,
        toStoreId,
        type: data.type,
        actorId: data.actorId,
        requestKey: data.requestKey,
        requestHash: data.requestHash,
        transitDelta,
        onHandDelta,
        releasedDelta,
        transitAfter: next.inTransit,
        onHandAfter: next.onHand,
        releasedAfter: next.released,
        expectedPartsBefore: parts(stock),
        expectedPartsAfter: next.expectedParts,
        stockVersionAfter: stock.version + 1,
        reason: data.reason,
        reversalOfId: data.reversalOfId,
        countId: data.countId,
        pickupRunId: data.pickupRunId,
        installationJobId: data.installationJobId,
        installationAddress: data.installationAddress,
      },
      include: movementInclude,
    });
    return {
      stock: presentStock(await this.load(tx, stock.lineNumber)),
      movement: presentMovement(movement),
      replayed: false,
    };
  }

  async stores(actor: AuthUser) {
    this.staff(actor);
    return this.prisma.$transaction(async (tx) => {
      const stores = await tx.warehouseStore.findMany({ orderBy: { name: 'asc' } });
      const balances = await tx.warehouseStoreStock.groupBy({
        by: ['storeId'], where: { onHand: { gt: 0 } },
        _sum: { onHand: true }, _count: { _all: true },
      });
      return stores.map((s) => {
        const total = balances.find((b) => b.storeId === s.id);
        return { ...s, onHand: total?._sum.onHand ?? 0, units: total?._count._all ?? 0 };
      });
    });
  }
  async createStore(dto: WarehouseStoreCreateDto, actor: AuthUser) {
    this.staff(actor, true);
    const name = storeName(dto.name);
    return this.transaction(async (tx) => {
      if (await tx.warehouseStore.findUnique({ where: { name } }))
        throw new ConflictException('A store with this name already exists. Rename or reactivate that store.');
      return tx.warehouseStore.create({ data: { name } });
    });
  }
  async updateStore(id: number, dto: WarehouseStoreUpdateDto, actor: AuthUser) {
    this.staff(actor, true);
    const name = storeName(dto.name);
    if (typeof dto.isActive !== 'boolean' || !Number.isSafeInteger(dto.version) || dto.version < 0)
      throw new BadRequestException('Enter a valid store status and version.');
    return this.transaction(async (tx) => {
      await this.lockStores(tx, [id]);
      const duplicate = await tx.warehouseStore.findUnique({ where: { name } });
      if (duplicate && duplicate.id !== id)
        throw new ConflictException('A store with this name already exists.');
      if (!dto.isActive) {
        if (await tx.warehouseStoreStock.count({ where: { storeId: id, onHand: { gt: 0 } } }))
          throw new ConflictException('Transfer all parts out of this store before deactivating it.');
        if (await tx.warehouseCount.count({ where: { storeId: id, status: 'OPEN' } }))
          throw new ConflictException('Finish or cancel the physical count for this store before deactivating it.');
      }
      const changed = await tx.warehouseStore.updateMany({
        where: { id, version: dto.version },
        data: { name, isActive: dto.isActive, version: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new ConflictException('This store changed. Refresh before saving.');
      return tx.warehouseStore.findUniqueOrThrow({ where: { id } });
    });
  }
  async receive(dto: WarehouseReceiptDto, actor: AuthUser) {
    this.receivingStaff(actor);
    if (!Number.isSafeInteger(dto.storeId) || dto.storeId < 1)
      throw new BadRequestException('Choose a destination store.');
    if (!Array.isArray(dto.items) || !dto.items.length || dto.items.length > 500)
      throw new BadRequestException('Select between 1 and 500 units per receipt.');
    if (dto.items.some((item) => !item || typeof item !== 'object'))
      throw new BadRequestException('Select valid receipt units.');
    const items = dto.items.map((item) => ({
      lineNumber: barcodeLine(item.barcode), quantity: item.quantity, version: item.version,
    })).sort((a, b) => a.lineNumber.localeCompare(b.lineNumber));
    if (new Set(items.map((i) => i.lineNumber)).size !== items.length ||
        items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 200 ||
          !Number.isSafeInteger(i.version) || i.version < 0))
      throw new BadRequestException('Choose each unit once and enter valid quantities and versions.');
    const requestHash = hash([actor.id, 'BATCH_RECEIVE', dto.storeId, items]);
    return this.transaction(async (tx) => {
      // El primer movimiento identifica el lote completo. Todo el lote se confirma
      // en una sola transacción; nunca queda un recibo parcialmente aplicado.
      const prior = await tx.warehouseMovement.findUnique({
        where: { requestKey: dto.requestKey }, include: movementInclude,
      });
      const summary = {
        units: items.length,
        parts: items.reduce((sum, i) => sum + i.quantity, 0),
        storeId: dto.storeId,
      };
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new ConflictException('This request identifier was already used for another operation.');
        return { ...summary, storeName: prior.toStore?.name ?? '', replayed: true };
      }
      await this.noCount(tx);
      await this.lockStores(tx, [dto.storeId], [dto.storeId]);
      const store = await tx.warehouseStore.findUniqueOrThrow({ where: { id: dto.storeId } });
      for (const [index, item] of items.entries()) {
        const stock = await this.load(tx, item.lineNumber);
        if (stock.version !== item.version)
          throw new ConflictException(`Unit I${item.lineNumber} changed. Refresh the selection before receiving. No parts were received by this request.`);
        if (stock.inTransit < item.quantity)
          throw new BadRequestException(`Unit I${item.lineNumber} does not have that many parts in transit. No parts were received by this request.`);
        await this.move(tx, stock, {
          type: 'RECEIVE', actorId: actor.id,
          requestKey: index === 0 ? dto.requestKey : hash([dto.requestKey, item.lineNumber]),
          requestHash, quantity: item.quantity,
          transitDelta: -item.quantity, onHandDelta: item.quantity,
          toStoreId: dto.storeId,
        });
      }
      return { ...summary, storeName: store.name, replayed: false };
    }, 60000);
  }
  async deliverToInstallation(dto: WarehouseInstallationDeliveryDto, actor: AuthUser) {
    this.receivingStaff(actor);
    if (!Number.isSafeInteger(dto.installationJobId) || dto.installationJobId < 1 ||
        typeof dto.installationAddress !== 'string' || !dto.installationAddress.trim() || dto.installationAddress.length > 500)
      throw new BadRequestException('Choose an installation and confirm its delivery address.');
    if (!Array.isArray(dto.items) || !dto.items.length || dto.items.length > 500 ||
        dto.items.some((item) => !item || typeof item !== 'object'))
      throw new BadRequestException('Select between 1 and 500 units per installation delivery.');
    const items = dto.items.map((item) => ({
      lineNumber: barcodeLine(item.barcode), quantity: item.quantity, version: item.version,
    })).sort((a, b) => a.lineNumber.localeCompare(b.lineNumber));
    if (new Set(items.map((i) => i.lineNumber)).size !== items.length ||
        items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 200 ||
          !Number.isSafeInteger(i.version) || i.version < 0))
      throw new BadRequestException('Choose each unit once and enter valid quantities and versions.');
    const requestHash = hash([actor.id, 'INSTALLATION_DELIVERY', dto.installationJobId, dto.installationAddress, items]);
    return this.transaction(async (tx) => {
      const prior = await tx.warehouseMovement.findUnique({
        where: { requestKey: dto.requestKey }, include: movementInclude,
      });
      const summary = { units: items.length, parts: items.reduce((sum, item) => sum + item.quantity, 0) };
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new ConflictException('This request identifier was already used for another operation.');
        return { ...summary, installation: { id: prior.installationJobId!, address: prior.installationAddress ?? '' }, replayed: true };
      }
      await this.noCount(tx);
      const first = await this.load(tx, items[0].lineNumber);
      const estimateId = first.unit.piece.idEst;
      // Las mismas validaciones comerciales que Release; recoger y recibir siguen independientes.
      const release = await assertWarehouseRelease(tx, estimateId);
      const destination = release.installation;
      if (!destination || destination.id !== dto.installationJobId)
        throw new BadRequestException('The selected order is not assigned to this installation.');
      if (release.fulfillmentMethod === 'INSTALLATION_DELIVERY') {
        // Entregar con la cuadrilla conserva las cuotas previas al trabajo y cualquier cargo de entrega.
        await assertScheduleMilestone(tx, estimateId, 'INSTALL');
        if (!release.installationDeliveryCovered)
          throw new BadRequestException('The delivery charge must be paid before delivering parts to the installation.');
      }
      if (!destination.address || destination.address !== dto.installationAddress)
        throw new ConflictException('The installation address changed. Refresh and confirm the destination again.');
      // Una confirmación corresponde a una obra. El lote completo se revierte ante cualquier conflicto.
      for (const [index, item] of items.entries()) {
        const stock = await this.load(tx, item.lineNumber);
        if (stock.unit.piece.idEst !== estimateId)
          throw new BadRequestException('Select parts for one installation at a time. No parts were delivered by this request.');
        if (stock.version !== item.version)
          throw new ConflictException(`Unit I${item.lineNumber} changed. Refresh the selection before delivering. No parts were delivered by this request.`);
        if (stock.inTransit < item.quantity)
          throw new BadRequestException(`Unit I${item.lineNumber} does not have that many parts in transit. No parts were delivered by this request.`);
        await this.move(tx, stock, {
          type: 'INSTALLATION_DELIVERY', actorId: actor.id,
          requestKey: index === 0 ? dto.requestKey : hash([dto.requestKey, item.lineNumber]),
          requestHash, quantity: item.quantity,
          transitDelta: -item.quantity, releasedDelta: item.quantity,
          installationJobId: destination.id, installationAddress: destination.address,
        });
      }
      return { ...summary, installation: destination, replayed: false };
    }, 60000);
  }
  async transfer(dto: WarehouseTransferDto, actor: AuthUser) {
    this.staff(actor);
    const lineNumber = barcodeLine(dto.barcode);
    if (dto.fromStoreId === undefined ||
        (dto.fromStoreId !== null && (!Number.isSafeInteger(dto.fromStoreId) || dto.fromStoreId < 1)) ||
        !Number.isSafeInteger(dto.toStoreId) || dto.toStoreId < 1 || dto.fromStoreId === dto.toStoreId ||
        !Number.isInteger(dto.quantity) || dto.quantity < 1 || dto.quantity > 200 ||
        !Number.isSafeInteger(dto.version) || dto.version < 0)
      throw new BadRequestException('Choose different source and destination locations and a valid quantity.');
    const requestHash = hash([actor.id, 'TRANSFER', lineNumber, dto.fromStoreId, dto.toStoreId, dto.quantity, dto.version]);
    return this.transaction(async (tx) => {
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay) return replay;
      await this.noCount(tx);
      await this.lockStores(tx,
        dto.fromStoreId === null ? [dto.toStoreId] : [dto.fromStoreId, dto.toStoreId], [dto.toStoreId]);
      const stock = await this.load(tx, lineNumber);
      if (stock.version !== dto.version)
        throw new ConflictException('This unit changed. Refresh its details before transferring parts.');
      if (storeQuantity(stock, dto.fromStoreId) < dto.quantity)
        throw new BadRequestException('Not enough parts in the selected source location.');
      return this.move(tx, stock, {
        type: 'TRANSFER', actorId: actor.id,
        requestKey: dto.requestKey, requestHash,
        quantity: dto.quantity, fromStoreId: dto.fromStoreId, toStoreId: dto.toStoreId,
      });
    });
  }

  private inventoryWhere(query: Query) {
    const view = query.view ?? 'on_hand';
    const where: Prisma.WarehouseStockWhereInput = stockSearch(query.search);
    if (view === 'on_hand') where.onHand = { gt: 0 };
    else if (view === 'in_transit') where.inTransit = { gt: 0 };
    else if (view === 'complete')
      where.AND = [
        { onHand: { gt: 0 } },
        { onHand: { equals: this.prisma.warehouseStock.fields.expectedParts } },
      ];
    else if (view === 'partial')
      where.AND = [
        { onHand: { gt: 0 } },
        { onHand: { lt: this.prisma.warehouseStock.fields.expectedParts } },
      ];
    else if (view !== 'all')
      throw new BadRequestException('Invalid inventory filter.');
    if (view === 'in_transit' && query.storeId && query.storeId !== 'all')
      throw new BadRequestException('In-transit parts have no store yet. Choose their destination in Pending receipt.');
    if (query.storeId && query.storeId !== 'all') {
      if (query.storeId === 'unassigned') where.unassigned = { gt: 0 };
      else {
        const storeId = Number(query.storeId);
        if (!Number.isSafeInteger(storeId) || storeId < 1)
          throw new BadRequestException('Invalid store filter.');
        where.storeBalances = { some: { storeId, onHand: { gt: 0 } } };
      }
    }
    return where;
  }

  private async inventoryMeta(tx: Tx, where: Prisma.WarehouseStockWhereInput, storeId = 'all') {
    const selectedStore = storeId !== 'all' && storeId !== 'unassigned';
    const [sum, activeCount, storeSum] = await Promise.all([
      tx.warehouseStock.aggregate({
        where,
        _sum: { onHand: true, unassigned: true, inTransit: true, released: true },
      }),
      tx.warehouseCount.findUnique({
        where: { activeSlot: 1 },
        select: { id: true },
      }),
      selectedStore ? tx.warehouseStoreStock.aggregate({
        where: { storeId: Number(storeId), stock: where },
        _sum: { onHand: true },
      }) : null,
    ]);
    return {
      summary: {
        onHand: selectedStore ? storeSum?._sum.onHand ?? 0
          : storeId === 'unassigned' ? sum._sum.unassigned ?? 0 : sum._sum.onHand ?? 0,
        unassigned: selectedStore ? 0 : sum._sum.unassigned ?? 0,
        // Estas cantidades no tienen ubicación actual; no se atribuyen a un Store.
        inTransit: storeId === 'all' ? sum._sum.inTransit ?? 0 : null,
        released: storeId === 'all' ? sum._sum.released ?? 0 : null,
      },
      activeCountId: activeCount?.id ?? null,
    };
  }

  async inventory(query: Query, actor: AuthUser) {
    this.staff(actor);
    const pagination = paging(query),
      where = this.inventoryWhere(query);
    return this.prisma.$transaction(async (tx) => {
      const [rows, total, meta] = await Promise.all([
        tx.warehouseStock.findMany({
          where,
          include: stockInclude,
          orderBy: { lineNumber: 'asc' },
          skip: pagination.skip,
          take: pagination.take,
        }),
        tx.warehouseStock.count({ where }),
        this.inventoryMeta(tx, where, query.storeId || 'all'),
      ]);
      return {
        items: rows.map(presentStock),
        total,
        page: pagination.page,
        pageSize: pagination.pageSize,
        ...meta,
      };
    });
  }

  async inventoryByPo(query: Query, actor: AuthUser) {
    this.staff(actor);
    const pagination = paging(query),
      where = this.inventoryWhere(query);
    return this.prisma.$transaction(async (tx) => {
      const matching = await tx.warehouseStock.findMany({
        where,
        select: {
          lineNumber: true,
          unit: {
            select: {
              piece: {
                select: {
                  estim: {
                    select: {
                      name: true,
                      customerFirstName: true,
                      customerLastName: true,
                      user: { select: actorSelect },
                      order: { select: { id: true, number: true, poNumber: true } },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { lineNumber: 'asc' },
      });
      type Group = {
        key: string;
        orderId: number | null;
        orderNumber: string;
        poNumber: string;
        customer: string;
        project: string;
        lineNumbers: string[];
      };
      const grouped = new Map<string, Group>();
      for (const row of matching) {
        const estimate = row.unit.piece.estim,
          order = estimate.order,
          key = order ? `order:${order.id}` : `line:${row.lineNumber}`;
        let group = grouped.get(key);
        if (!group) {
          group = {
            key,
            orderId: order?.id ?? null,
            orderNumber: order?.number ?? '',
            poNumber: order?.poNumber ?? '',
            customer:
              [estimate.customerFirstName, estimate.customerLastName]
                .filter(Boolean)
                .join(' ') || name(estimate.user),
            project: estimate.name,
            lineNumbers: [],
          };
          grouped.set(key, group);
        }
        group.lineNumbers.push(row.lineNumber);
      }
      const groups = [...grouped.values()].sort((a, b) => {
        const aKey = a.poNumber || a.orderNumber || a.key,
          bKey = b.poNumber || b.orderNumber || b.key;
        return aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' });
      });
      const pageGroups = groups.slice(pagination.skip, pagination.skip + pagination.take),
        lineNumbers = pageGroups.flatMap((group) => group.lineNumbers),
        rows = lineNumbers.length
          ? await tx.warehouseStock.findMany({
              where: { ...where, lineNumber: { in: lineNumbers } },
              include: stockInclude,
              orderBy: { lineNumber: 'asc' },
            })
          : [],
        byLine = new Map(rows.map((row) => [row.lineNumber, presentStock(row)])),
        meta = await this.inventoryMeta(tx, where, query.storeId || 'all');
      return {
        items: pageGroups.map((group) => ({
          key: group.key,
          orderId: group.orderId,
          orderNumber: group.orderNumber,
          poNumber: group.poNumber,
          customer: group.customer,
          project: group.project,
          units: group.lineNumbers
            .map((lineNumber) => byLine.get(lineNumber))
            .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit)),
        })),
        total: groups.length,
        page: pagination.page,
        pageSize: pagination.pageSize,
        ...meta,
      };
    });
  }
  async unit(barcode: string, actor: AuthUser) {
    this.staff(actor);
    return presentStock(await this.load(this.prisma, barcodeLine(barcode)));
  }
  async history(query: Query, actor: AuthUser) {
    this.staff(actor);
    const p = paging(query);
    const where: Prisma.WarehouseMovementWhereInput = query.lineNumber
      ? { lineNumber: barcodeLine(query.lineNumber) }
      : { stock: stockSearch(query.search) };
    return this.prisma.$transaction(async (tx) => ({
      items: (
        await tx.warehouseMovement.findMany({
          where,
          include: movementInclude,
          orderBy: { id: 'desc' },
          skip: p.skip,
          take: p.take,
        })
      ).map(presentMovement),
      total: await tx.warehouseMovement.count({ where }),
      page: p.page,
      pageSize: p.pageSize,
    }));
  }
  async scan(dto: WarehouseScanDto, actor: AuthUser) {
    this.receivingStaff(actor);
    // Defensa en servicio: no basta con ocultar la salida en el teléfono.
    if (actor.role?.name === 'technician' && !['COLLECT', 'RECEIVE'].includes(dto.action))
      throw new ForbiddenException('Technicians can only collect or receive parts.');
    const lineNumber = barcodeLine(dto.barcode),
      requestHash = hash(dto.storeId === undefined
        ? [actor.id, dto.action, lineNumber]
        : [actor.id, dto.action, lineNumber, dto.storeId]);
    return this.transaction(async (tx) => {
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay) return replay;
      await this.noCount(tx);
      if (dto.action === 'COLLECT' && dto.storeId != null)
        throw new BadRequestException('Factory collection does not assign a store.');
      if (dto.action === 'RECEIVE' && (!Number.isSafeInteger(dto.storeId) || dto.storeId! < 1))
        throw new BadRequestException('Choose the destination store before receiving parts.');
      if (dto.action === 'RELEASE' && dto.storeId === undefined)
        throw new BadRequestException('Choose the source store, or explicitly select Unassigned.');
      if (dto.storeId != null)
        await this.lockStores(tx, [dto.storeId], dto.action === 'RECEIVE' ? [dto.storeId] : []);
      const stock = await this.load(tx, lineNumber);
      const deltas = { transitDelta: 0, onHandDelta: 0, releasedDelta: 0 };
      let installation: ReturnType<typeof installationDestination> = null;
      if (dto.action === 'COLLECT') {
        assertCompanyFactoryCollection(stock.unit.piece.estim.order!);
        const activePickup = await tx.factoryPickupRunOrder.findFirst({
          where: { orderId: stock.unit.piece.estim.order!.id, activeSlot: 1 }, select: { pickupRunId: true },
        });
        if (activePickup)
          throw new ConflictException('Open the assigned factory pickup to collect parts for this PO.');
        deltas.transitDelta = 1;
      }
      else if (dto.action === 'RECEIVE') {
        // Recibir permite llegada directa; si hay partes en tránsito, consume una.
        deltas.transitDelta = stock.inTransit > 0 ? -1 : 0;
        deltas.onHandDelta = 1;
      } else if (dto.action === 'RELEASE') {
        if (!stock.onHand)
          throw new BadRequestException(
            'There are no parts of this unit in the warehouse.',
          );
        installation = (await assertWarehouseRelease(tx, stock.unit.piece.idEst))?.installation ?? null;
        deltas.onHandDelta = -1;
        deltas.releasedDelta = 1;
      } else throw new BadRequestException('Invalid warehouse action.');
      return this.move(tx, stock, {
        ...deltas,
        type: dto.action,
        actorId: actor.id,
        requestKey: dto.requestKey,
        requestHash,
        quantity: 1,
        fromStoreId: dto.action === 'RELEASE' ? dto.storeId : null,
        toStoreId: dto.action === 'RECEIVE' ? dto.storeId : null,
        installationJobId: installation?.id,
        installationAddress: installation?.address,
      });
    });
  }
  async setParts(barcode: string, dto: WarehousePartsDto, actor: AuthUser) {
    this.staff(actor, true);
    const lineNumber = barcodeLine(barcode),
      requestHash = hash([
        actor.id,
        'PARTS',
        lineNumber,
        dto.expectedParts,
        dto.version,
        dto.reason,
      ]);
    if (
      !Number.isInteger(dto.expectedParts) ||
      dto.expectedParts < 1 ||
      dto.expectedParts > 200 ||
      dto.reason.trim().length < 3
    )
      throw new BadRequestException('Enter the expected parts and a reason.');
    return this.transaction(async (tx) => {
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay) return replay;
      await this.noCount(tx);
      const stock = await this.load(tx, lineNumber);
      if (stock.version !== dto.version)
        throw new ConflictException(
          'This unit changed. Refresh before editing expected parts.',
        );
      if (dto.expectedParts !== parts(stock) && await tx.factoryPickupRunOrder.findFirst({
        where: { orderId: stock.unit.piece.estim.order!.id, activeSlot: 1 },
      }))
        throw new ConflictException(
          'Finish the active factory pickup before changing expected parts. Then start a new pickup for any remaining parts.',
        );
      return this.move(tx, stock, {
        type: 'PARTS',
        actorId: actor.id,
        requestKey: dto.requestKey,
        requestHash,
        expectedParts: dto.expectedParts,
        reason: dto.reason.trim(),
      });
    });
  }
  async undo(id: number, dto: WarehouseRequestDto, actor: AuthUser) {
    this.staff(actor);
    const requestHash = hash([actor.id, 'UNDO', id]);
    return this.transaction(async (tx) => {
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay) return replay;
      const m = await tx.warehouseMovement.findUnique({
        where: { id },
        include: movementInclude,
      });
      if (!m) throw new NotFoundException('Reading not found.');
      if (m.actorId !== actor.id && actor.role?.name !== 'admin')
        throw new ForbiddenException('You can undo only your own readings.');
      if (
        m.reversal ||
        !['COLLECT', 'RECEIVE', 'RELEASE', 'INSTALLATION_DELIVERY', 'TRANSFER', 'COUNT'].includes(m.type)
      )
        throw new BadRequestException('This reading cannot be undone.');
      if (m.type === 'COLLECT' && m.pickupRunId)
        await this.lockPickupRun(tx, m.pickupRunId, actor);
      const stock = await this.load(tx, m.lineNumber);
      if (m.type === 'COUNT') {
        await this.openCount(tx, m.countId!);
        const changed = await tx.warehouseCountLine.updateMany({
          where: {
            countId: m.countId!,
            lineNumber: m.lineNumber,
            counted: { gt: 0 },
          },
          data: { counted: { decrement: 1 } },
        });
        if (changed.count !== 1)
          throw new ConflictException(
            'This count reading is no longer available.',
          );
        return this.countMovement(tx, stock, {
          countId: m.countId!,
          countDelta: -1,
          type: 'COUNT_UNDO',
          actorId: actor.id,
          requestKey: dto.requestKey,
          requestHash,
          reversalOfId: m.id,
        });
      }
      await this.noCount(tx);
      if (stock.version !== m.stockVersionAfter)
        throw new ConflictException(
          'This unit has newer movements. Only its latest reading can be undone.',
        );
      await this.lockStores(tx,
        [m.fromStoreId, m.toStoreId].filter((id): id is number => id !== null),
        m.fromStoreId !== null ? [m.fromStoreId] : []);
      return this.move(tx, stock, {
        type: 'UNDO',
        actorId: actor.id,
        requestKey: dto.requestKey,
        requestHash,
        transitDelta: -m.transitDelta,
        onHandDelta: -m.onHandDelta,
        releasedDelta: -m.releasedDelta,
        quantity: m.quantity,
        fromStoreId: m.toStoreId,
        toStoreId: m.fromStoreId,
        reversalOfId: m.id,
        installationJobId: m.installationJobId,
        installationAddress: m.installationAddress,
      });
    });
  }

  async counts(actor: AuthUser) {
    this.staff(actor);
    return this.prisma.warehouseCount.findMany({
      orderBy: { id: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        scope: true,
        storeId: true,
        store: { select: storeSelect },
        startedAt: true,
        closedAt: true,
        reason: true,
        startedBy: { select: actorSelect },
        closedBy: { select: actorSelect },
      },
    });
  }
  async startCount(dto: WarehouseCountStartDto, actor: AuthUser) {
    this.staff(actor);
    const scope = dto.scope ?? 'ALL', storeId = dto.storeId ?? null;
    if (!['ALL', 'STORE', 'UNASSIGNED'].includes(scope) ||
        (scope === 'STORE' ? !Number.isSafeInteger(storeId) || storeId! < 1 : storeId !== null))
      throw new BadRequestException('Choose a valid physical count location.');
    return this.transaction(async (tx) => {
      const prior = await tx.warehouseCount.findUnique({
        where: { requestKey: dto.requestKey },
      });
      if (prior) {
        if (prior.startedById !== actor.id || prior.scope !== scope || prior.storeId !== storeId)
          throw new ConflictException('Request identifier already used.');
        return { id: prior.id };
      }
      await this.noCount(tx);
      if (storeId !== null) await this.lockStores(tx, [storeId], [storeId]);
      const created = await tx.warehouseCount.create({
        data: {
          requestKey: dto.requestKey,
          activeSlot: 1,
          startedById: actor.id,
          scope,
          storeId,
        },
      });
      // Fotografía de existencias reales. Las unidades a cero se agregan si se escanean.
      const rows = await tx.warehouseStock.findMany({
        where: scope === 'ALL' ? { onHand: { gt: 0 } }
          : scope === 'UNASSIGNED' ? { unassigned: { gt: 0 } }
          : { storeBalances: { some: { storeId: storeId!, onHand: { gt: 0 } } } },
        include: stockInclude,
      });
      for (let offset = 0; offset < rows.length; offset += 500) {
        await tx.warehouseCountLine.createMany({
          data: rows.slice(offset, offset + 500).map((s) => ({
            countId: created.id,
            lineNumber: s.lineNumber,
            expected: countQuantity(s, created),
            stockVersion: s.version,
          })),
        });
      }
      return { id: created.id };
    });
  }
  private async openCount(tx: Tx, id: number) {
    await tx.$queryRaw`SELECT id FROM warehouse_counts WHERE id = ${id} FOR UPDATE`;
    const count = await tx.warehouseCount.findUnique({ where: { id } });
    if (!count) throw new NotFoundException('Physical count not found.');
    if (count.status !== 'OPEN')
      throw new ConflictException('This physical count is closed.');
    return count;
  }
  async count(id: number, query: Query, actor: AuthUser) {
    this.staff(actor);
    const p = paging(query);
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.warehouseCount.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          scope: true,
          storeId: true,
          store: { select: storeSelect },
          startedAt: true,
          closedAt: true,
          reason: true,
          startedBy: { select: actorSelect },
          closedBy: { select: actorSelect },
        },
      });
      if (!count) throw new NotFoundException('Physical count not found.');
      const where: Prisma.WarehouseCountLineWhereInput = {
        countId: id,
        stock: stockSearch(query.search),
      };
      if (query.differences === 'true')
        where.counted = {
          not: { equals: this.prisma.warehouseCountLine.fields.expected },
        };
      const rows = await tx.warehouseCountLine.findMany({
        where,
        include: { stock: { include: stockInclude } },
        orderBy: { lineNumber: 'asc' },
        skip: p.skip,
        take: p.take,
      });
      const totals = await tx.warehouseCountLine.aggregate({
        where: { countId: id },
        _sum: { expected: true, counted: true },
      });
      const differences = await tx.warehouseCountLine.count({
        where: {
          countId: id,
          counted: {
            not: { equals: this.prisma.warehouseCountLine.fields.expected },
          },
        },
      });
      const allLines = await tx.warehouseCountLine.findMany({
        where: { countId: id },
        select: {
          lineNumber: true,
          expected: true,
          counted: true,
          stockVersion: true,
        },
      });
      return {
        ...count,
        revision: countRevision(id, allLines),
        items: rows.map((r) => ({
          stock: presentStock(r.stock),
          expected: r.expected,
          counted: r.counted,
          difference: r.counted - r.expected,
        })),
        total: await tx.warehouseCountLine.count({ where }),
        page: p.page,
        pageSize: p.pageSize,
        expected: totals._sum.expected ?? 0,
        counted: totals._sum.counted ?? 0,
        differences,
      };
    });
  }
  private async countMovement(
    tx: Tx,
    stock: Stock,
    data: {
      countId: number;
      countDelta: number;
      type: 'COUNT' | 'COUNT_UNDO';
      actorId: number;
      requestKey: string;
      requestHash: string;
      reversalOfId?: number;
    },
  ) {
    const movement = await tx.warehouseMovement.create({
      data: {
        ...data,
        quantity: Math.abs(data.countDelta),
        lineNumber: stock.lineNumber,
        transitAfter: stock.inTransit,
        onHandAfter: stock.onHand,
        releasedAfter: stock.released,
        expectedPartsBefore: parts(stock),
        expectedPartsAfter: parts(stock),
        stockVersionAfter: stock.version,
      },
      include: movementInclude,
    });
    const line = await tx.warehouseCountLine.findUniqueOrThrow({
      where: {
        countId_lineNumber: {
          countId: data.countId,
          lineNumber: stock.lineNumber,
        },
      },
    });
    return {
      stock: presentStock(stock),
      movement: presentMovement(movement),
      counted: line.counted,
      replayed: false,
    };
  }
  async countScan(id: number, dto: WarehouseCountScanDto, actor: AuthUser) {
    this.staff(actor);
    const lineNumber = barcodeLine(dto.barcode),
      requestHash = hash([actor.id, 'COUNT', id, lineNumber]);
    return this.transaction(async (tx) => {
      const replay = await this.replay(tx, dto.requestKey, requestHash);
      if (replay) {
        const line = await tx.warehouseCountLine.findUniqueOrThrow({
          where: { countId_lineNumber: { countId: id, lineNumber } },
        });
        return { ...replay, counted: line.counted };
      }
      const count = await this.openCount(tx, id);
      const stock = await this.load(tx, lineNumber),
        expectedParts = parts(stock);
      if (!expectedParts)
        throw new BadRequestException(
          'Expected parts are not configured. Cancel this count and ask an administrator to configure this unit.',
        );
      const line = await tx.warehouseCountLine.upsert({
        where: { countId_lineNumber: { countId: id, lineNumber } },
        create: {
          countId: id,
          lineNumber,
          expected: countQuantity(stock, count),
          stockVersion: stock.version,
        },
        update: {},
      });
      const otherLocations = stock.onHand - countQuantity(stock, count);
      if (line.counted + 1 + otherLocations + stock.inTransit + stock.released > expectedParts)
        throw new BadRequestException(
          'This reading exceeds the parts that can be in the warehouse. Review the readings, other stores, and transit or release records.',
        );
      await tx.warehouseCountLine.update({
        where: { countId_lineNumber: { countId: id, lineNumber } },
        data: { counted: { increment: 1 } },
      });
      return this.countMovement(tx, stock, {
        countId: id,
        countDelta: 1,
        type: 'COUNT',
        actorId: actor.id,
        requestKey: dto.requestKey,
        requestHash,
      });
    });
  }
  async closeCount(id: number, dto: WarehouseCountCloseDto, actor: AuthUser) {
    this.staff(actor);
    if (!['COMPLETE', 'CANCEL'].includes(dto.action))
      throw new BadRequestException('Invalid count action.');
    return this.transaction(async (tx) => {
      const previous = await tx.warehouseCount.findUnique({ where: { id } });
      const desired = dto.action === 'CANCEL' ? 'CANCELED' : 'COMPLETED';
      if (previous?.status === desired) return { id, status: desired };
      const count = await this.openCount(tx, id);
      if (dto.action === 'CANCEL') {
        if (count.startedById !== actor.id && actor.role?.name !== 'admin')
          throw new ForbiddenException(
            'Only the person who started this count or an administrator can cancel it.',
          );
      } else {
        const lines = await tx.warehouseCountLine.findMany({
          where: { countId: id },
          include: { stock: { include: stockInclude } },
        });
        if (dto.revision !== countRevision(id, lines))
          throw new ConflictException(
            'This count changed. Refresh and review its current differences before closing it.',
          );
        const different = lines.filter((l) => l.counted !== l.expected);
        if (different.length) {
          this.staff(actor, true);
          if (!dto.reason || dto.reason.trim().length < 3)
            throw new BadRequestException(
              'Review the differences and enter a reason before applying inventory adjustments.',
            );
        }
        if (count.storeId !== null) await this.lockStores(tx, [count.storeId], [count.storeId]);
        for (const line of lines) {
          if (line.stockVersion !== line.stock.version)
            throw new ConflictException(
              'Stock changed during this count. Cancel it and start a new count.',
            );
          if (line.counted !== line.expected) {
            await this.move(tx, line.stock, {
              type: 'ADJUST',
              actorId: actor.id,
              requestKey: `count:${id}:${hash(line.lineNumber).slice(0, 30)}`,
              requestHash: hash([
                'COUNT_ADJUST',
                id,
                line.lineNumber,
                line.counted,
              ]),
              countId: id,
              onHandDelta: line.counted - line.expected,
              quantity: Math.abs(line.counted - line.expected),
              fromStoreId: line.counted < line.expected ? count.storeId : null,
              toStoreId: line.counted > line.expected ? count.storeId : null,
              reason: dto.reason!.trim(),
            });
          }
        }
      }
      await tx.warehouseCount.update({
        where: { id },
        data: {
          status: desired,
          activeSlot: null,
          closedAt: new Date(),
          closedById: actor.id,
          reason: dto.reason?.trim(),
        },
      });
      return { id, status: desired };
    });
  }
}

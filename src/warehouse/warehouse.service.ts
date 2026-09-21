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
import {
  barcodeLine,
  expectedPhysicalParts,
  assertBalances,
} from './warehouse-parts';
import { assertWarehouseRelease } from './warehouse-release';
import {
  WarehouseScanDto,
  WarehouseRequestDto,
  WarehousePartsDto,
  WarehouseCountScanDto,
  WarehouseCountCloseDto,
  WarehouseCountStartDto,
  WarehouseReceiptDto,
  WarehouseTransferDto,
  WarehouseStoreCreateDto,
  WarehouseStoreUpdateDto,
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
              order: { select: { id: true, number: true, poNumber: true } },
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
    this.staff(actor);
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

  async inventory(query: Query, actor: AuthUser) {
    this.staff(actor);
    const pagination = paging(query),
      view = query.view ?? 'on_hand';
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
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.warehouseStock.findMany({
        where,
        include: stockInclude,
        orderBy: { lineNumber: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      });
      const total = await tx.warehouseStock.count({ where });
      const sum = await tx.warehouseStock.aggregate({
        _sum: { onHand: true, unassigned: true, inTransit: true, released: true },
      });
      const activeCount = await tx.warehouseCount.findUnique({
        where: { activeSlot: 1 },
        select: { id: true },
      });
      return {
        items: rows.map(presentStock),
        total,
        page: pagination.page,
        pageSize: pagination.pageSize,
        summary: {
          onHand: sum._sum.onHand ?? 0,
          unassigned: sum._sum.unassigned ?? 0,
          inTransit: sum._sum.inTransit ?? 0,
          released: sum._sum.released ?? 0,
        },
        activeCountId: activeCount?.id ?? null,
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
    this.staff(actor);
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
      if (dto.action === 'COLLECT') deltas.transitDelta = 1;
      else if (dto.action === 'RECEIVE') {
        // Recibir permite llegada directa; si hay partes en tránsito, consume una.
        deltas.transitDelta = stock.inTransit > 0 ? -1 : 0;
        deltas.onHandDelta = 1;
      } else if (dto.action === 'RELEASE') {
        if (!stock.onHand)
          throw new BadRequestException(
            'There are no parts of this unit in the warehouse.',
          );
        await assertWarehouseRelease(tx, stock.unit.piece.idEst);
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
        !['COLLECT', 'RECEIVE', 'RELEASE', 'TRANSFER', 'COUNT'].includes(m.type)
      )
        throw new BadRequestException('This reading cannot be undone.');
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

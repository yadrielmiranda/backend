import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { ExternalPoController } from './external-po.controller';
import { ExternalPoService } from './external-po.service';
import { parseExternalPo } from './external-po-parser';

const admin = { id: 1, role: { name: 'admin' as const } };
const line = (line_number = 100, description = 'Horizontal Rolling Window OX Bronze', panels: unknown = 1) => ({
  line_number, description, qty: 1, mark: '', product_details: { panels },
});
const document = (lines = [line()]) => ({
  schema: 'ews.purchase-order.ai-export.v3', po_number: 293540,
  order_name: 'Previous project', supplier: { name: 'ECO Window Systems' }, lines,
});
const file = (value: unknown = document()) => Buffer.from(JSON.stringify(value));

function fixture() {
  let po: any = null;
  const units: any[] = [];
  const stock = (row: any) => ({ ...row, _count: row._count ?? { movements: 0, countLines: 0, pickupRunLines: 0 } });
  const db: any = {
    $queryRaw: jest.fn(async () => []),
    order: { findUnique: jest.fn(async () => null as any), update: jest.fn() },
    factoryPo: {
      findUnique: jest.fn(async () => po && ({ ...po, externalUnits: units.filter((unit) => unit.externalPoId === po.id).map((unit) => ({ ...unit, stock: unit.stock && stock(unit.stock) })) })),
      create: jest.fn(async ({ data }) => po = { ...data, id: 1, orderId: null }),
      update: jest.fn(async ({ data }) => po = { ...po, ...data }),
    },
    factoryUnit: {
      findMany: jest.fn(async ({ where }) => units.filter((unit) => where.lineNumber.in.includes(unit.lineNumber))),
      createMany: jest.fn(async ({ data }) => { units.push(...data); return { count: data.length }; }),
      update: jest.fn(async ({ where, data }) => Object.assign(units.find((unit) => unit.lineNumber === where.lineNumber), data)),
    },
    warehouseStock: {
      createMany: jest.fn(async ({ data }) => {
        for (const row of data) units.find((unit) => unit.lineNumber === row.lineNumber).stock = {
          inTransit: 0, onHand: 0, unassigned: 0, released: 0, ...row,
        };
        return { count: data.length };
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        const unit = units.find((row) => row.lineNumber === where.lineNumber);
        unit.stock = unit.stock ? { ...unit.stock, expectedParts: update.expectedParts, version: unit.stock.version + update.version.increment } : create;
        return unit.stock;
      }),
    },
    warehouseCount: { findUnique: jest.fn(async () => null as any) },
    factoryPickupRunOrder: { findFirst: jest.fn(async () => null as any) },
    eventLog: { create: jest.fn() },
  };
  db.$transaction = jest.fn(async (callback) => callback(db));
  const service = new ExternalPoService(db);
  const preview = (input = file()) => service.preview(input, admin);
  const confirm = async (input = file(), fields: Record<string, string> = {}) => {
    const p = await preview(input);
    return service.confirm(input, {
      revision: p.revision,
      parts: JSON.stringify(p.lines.map((item) => ({ lineNumber: item.lineNumber, expectedParts: item.expectedParts }))),
      ...fields,
    }, admin);
  };
  return { db, units, service, preview, confirm };
}

describe('external PO parser', () => {
  it.each([
    ['Serie 600 French Door L.M.I. XX', 2, 3, 'FRENCH_DOOR'],
    ['Sliding Glass Door 700 - L.M.I. XOX', 3, 4, 'SLIDING_DOOR'],
    ['sliding door 700', 2, 3, 'SLIDING_DOOR'],
    ['Sliding Window OX', 1, 1, 'WINDOW'],
    ['Window Wall', 4, 4, 'WINDOW'],
    ['Mullion', 1, 1, 'LINEAR_MATERIAL'],
  ])('counts %s from explicit panels', (description, panels, expectedParts, family) => {
    expect(parseExternalPo(file(document([line(100, description, panels)]))).lines[0]).toMatchObject({ expectedParts, family, needsReview: false });
  });

  it('keeps only agreed data and ignores all financial and optional attribute values', () => {
    const input = {
      ...document(), currency: 'fictitious', status: { fake: true }, discounted_total: 'not money',
      supplier: { id: { bad: true }, name: 'ECO Window Systems' },
      lines: [{ ...line(), price: { arbitrary: true }, product_details: {
        panels: 1, configuration_id: [], panel_config: {}, width_in: 'wrong', height_in: -4, frame_color: 7,
      } }],
    };
    expect(parseExternalPo(file(input))).toEqual(parseExternalPo(file()));
  });

  it.each([
    line(100, 'Unknown item', 2),
    line(100, 'Sliding Window OX', undefined),
    line(100, 'French Door\nPanels: 1', 2),
    line(100, 'Sliding Glass Door', 200),
  ])('requires a reviewed count instead of guessing ambiguous parts', (item) => {
    if (item.description.includes('Sliding Window')) delete item.product_details.panels;
    expect(parseExternalPo(file(document([item]))).lines[0]).toMatchObject({ expectedParts: null, needsReview: true });
  });

  it('identifies the product only from its first description line', () => {
    expect(parseExternalPo(file(document([line(100, 'Window OX\nAccessory: French Door', 1)]))).lines[0].expectedParts).toBe(1);
  });

  it('preserves full fractional descriptions and empty or repeated marks', () => {
    const description = 'Window OX\nSize: 60 x 61 1/2\nGlass: clear';
    const result = parseExternalPo(file(document([line(100, description), line(101, description)])));
    expect(result.lines.map((item) => [item.mark, item.description])).toEqual([['', description], ['', description]]);
  });

  it.each([
    { ...document(), schema: 'other' },
    { ...document(), po_number: Number.MAX_SAFE_INTEGER + 1 },
    document([{ ...line(), qty: 2 }]),
    document([{ ...line(), description: '' }]),
    document([line(100), line(100)]),
    { ...document(), lines: [] },
  ])('rejects invalid identity or unit structure', (input) => expect(() => parseExternalPo(file(input))).toThrow());
});

describe('external PO import safety', () => {
  it('restricts HTTP and direct service calls to administrators', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, ExternalPoController)).toEqual(['admin']);
    const f = fixture(), user: any = { id: 2, role: { name: 'technician' } };
    await expect(f.service.preview(file(), user)).rejects.toThrow(ForbiddenException);
    await expect(f.service.confirm(file(), {}, user)).rejects.toThrow(ForbiddenException);
    expect(f.db.factoryPo.findUnique).not.toHaveBeenCalled();
  });

  it('previews without writes and imports identifiers and expected parts without receiving stock or touching accounting', async () => {
    const f = fixture();
    expect((await f.preview()).lines[0]).toMatchObject({ expectedParts: 1, existing: false, locked: false });
    expect(f.db.factoryPo.create).not.toHaveBeenCalled();
    expect(await f.confirm()).toEqual({ addedUnits: 1, linkedUnits: 1, unchanged: false });
    expect(f.units[0]).toMatchObject({ externalPoId: 1, lineNumber: '100', description: line().description,
      stock: { expectedParts: 1, inTransit: 0, onHand: 0, released: 0 } });
    expect(f.db.factoryPo.create.mock.calls[0][0].data).toEqual({ poNumber: '293540', orderName: 'Previous project', supplierName: 'ECO Window Systems' });
    expect(f.db.order.update).not.toHaveBeenCalled();
    expect(f.db.$transaction.mock.calls[0][1].isolationLevel).toBe('Serializable');
  });

  it('is idempotent and preserves stock history and reviewed counts', async () => {
    const f = fixture();
    await f.confirm();
    Object.assign(f.units[0].stock, { version: 3, expectedParts: 4, onHand: 2, inTransit: 1, released: 1,
      _count: { movements: 5, countLines: 1, pickupRunLines: 1 } });
    expect((await f.preview()).lines[0]).toMatchObject({ locked: true, expectedParts: 4 });
    expect(await f.confirm()).toEqual({ addedUnits: 0, linkedUnits: 1, unchanged: true });
    expect(f.units[0].stock).toMatchObject({ expectedParts: 4, onHand: 2, inTransit: 1, released: 1, version: 3 });
    expect(f.db.warehouseStock.upsert).not.toHaveBeenCalled();
  });

  it('requires explicit review and persists an ambiguous count so future imports do not overwrite it', async () => {
    const f = fixture(), input = file(document([line(100, 'Unrecognized assembly', null)]));
    const parts = JSON.stringify([{ lineNumber: '100', expectedParts: 5 }]);
    await expect(f.confirm(input, { parts })).rejects.toThrow('Review the descriptions');
    await f.confirm(input, { parts, reviewed: 'true' });
    expect(f.units[0].stock).toMatchObject({ expectedParts: 5, version: 1 });
    expect((await f.preview(input)).lines[0]).toMatchObject({ locked: true, expectedParts: 5, needsReview: false });
    expect((await f.confirm(input)).unchanged).toBe(true);
    await expect(f.confirm(input, { parts: '[{"lineNumber":"100","expectedParts":3}]', reviewed: 'true' })).rejects.toThrow('already reviewed');
  });

  it('requires review before revising untouched units and increments their stock version', async () => {
    const f = fixture();
    await f.confirm();
    const input = file(document([line(100, 'Window Wall', 3)]));
    await expect(f.confirm(input)).rejects.toThrow('Review the descriptions');
    await f.confirm(input, { reviewed: 'true' });
    expect(f.units[0].stock).toMatchObject({ expectedParts: 3, version: 1 });
    await expect(f.preview()).rejects.toThrow('saved description');
  });

  it('rejects PO and line ownership collisions, including internal units with no external PO', async () => {
    const f = fixture();
    f.db.order.findUnique.mockResolvedValue({ id: 99 });
    await expect(f.preview()).rejects.toThrow('system order');
    f.db.order.findUnique.mockResolvedValue(null);
    f.units.push({ lineNumber: '100', pieceId: 9, externalPoId: null });
    await expect(f.preview()).rejects.toThrow('already belongs');
  });

  it('does not drop existing lines or reassign them to a different PO', async () => {
    const f = fixture(); await f.confirm();
    await expect(f.preview(file(document([line(101)])))).rejects.toThrow('omits previously');
    f.db.factoryPo.findUnique.mockResolvedValue(null);
    await expect(f.preview(file({ ...document(), po_number: 293541 }))).rejects.toThrow('already belongs');
  });

  it.each(['pickup', 'count'])('blocks changes during an active %s but allows an unchanged reimport', async (kind) => {
    const f = fixture(); await f.confirm();
    if (kind === 'pickup') f.db.factoryPickupRunOrder.findFirst.mockResolvedValue({ pickupRunId: 9 });
    else f.db.warehouseCount.findUnique.mockResolvedValue({ id: 9 });
    expect((await f.confirm()).unchanged).toBe(true);
    await expect(f.confirm(file(document([line(), line(101)])))).rejects.toThrow(kind === 'pickup' ? 'active factory pickup' : 'open warehouse count');
    expect(f.units).toHaveLength(1);
  });

  it('rejects stale stock revisions and concurrent unique collisions', async () => {
    const f = fixture(); await f.confirm();
    const p = await f.preview(); f.units[0].stock.version++;
    await expect(f.service.confirm(file(), { revision: p.revision, parts: '[{"lineNumber":"100","expectedParts":1}]' }, admin)).rejects.toThrow('changed');
    const g = fixture(); g.db.factoryPo.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.18.0' }));
    await expect(g.confirm()).rejects.toThrow(ConflictException);
    expect(g.units).toHaveLength(0);
  });
});

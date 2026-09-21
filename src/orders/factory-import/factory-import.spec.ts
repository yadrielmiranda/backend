import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FactoryImportService } from './factory-import.service';
import { FactoryImportController } from './factory-import.controller';
import { ROLES_KEY } from '@/auth/roles.decorator';
import {
  inches,
  matchingIssues,
  matchFactoryLines,
  parseFactoryDocument,
  type LocalFactoryPiece,
} from './factory-import-matching';

const admin = { id: 1, role: { name: 'admin' as const } };
const factoryLine = (line_number = 100, mark = 'W1') => ({
  line_number,
  mark,
  qty: 1,
  description:
    'Serie 200 Horizontal Rolling Window L.M.I. OX Bronze\r\nSize: 60 x 59 1/2\r\nGlass: ignored',
  product_details: {
    configuration_id: 'HR200OX',
    panel_config: 'OX',
    width_in: 60,
    height_in: 59,
    frame_color: 'Bronze',
  },
  price: { discounted_unit: 500 },
});
const document = (lines = [factoryLine()]) => ({
  schema: 'ews.purchase-order.ai-export.v3',
  supplier: { id: 'ECO', email_domain: 'ignored' },
  currency: 'USD',
  po_number: 123,
  discounted_total: 15651.724,
  order_name: 'Test order',
  status: 'Warehouse',
  total: 999999,
  lines,
});
const file = (value: unknown = document()) =>
  Buffer.from(JSON.stringify(value));
const local = (
  overrides: Partial<LocalFactoryPiece> = {},
): LocalFactoryPiece => ({
  id: 10,
  mark: 'W1',
  qty: 1,
  brand: 'ECO Window Systems',
  product: 'Horizontal Rolling',
  family: 'HORIZONTAL_SLIDER',
  system: '200',
  configuration: 'OX',
  frameColor: 'Bronze',
  width: 60,
  height: 59.5,
  active: '',
  complexDimensions: false,
  matchKey: 'same',
  lineNumbers: [],
  ...overrides,
});

function fixture() {
  const order = {
    id: 1,
    number: '1001',
    idEst: 7,
    poNumber: null as string | null,
    rateReal: null as Prisma.Decimal | null,
    saleSubtotal: new Prisma.Decimal(20000),
    netProfitReal: null as Prisma.Decimal | null,
    updatedAt: new Date('2026-09-21T00:00:00Z'),
    statusId: 1,
    estimate: { name: 'Test order' },
  };
  const pieces: any[] = [
    {
      id: 10,
      idEst: 7,
      mark: 'W1',
      qty: 1,
      idBrand: 1,
      idProd: 1,
      idSyst: 1,
      idConf: 1,
      idFC: 1,
      width: new Prisma.Decimal(60),
      height: new Prisma.Decimal(59.5),
      ...Object.fromEntries(
        [
          'heightLeft',
          'heightRight',
          'legHeight',
          'sashHeight',
          'windowHeight',
          'doorWidth',
          'doorHeight',
          'leftSideliteWidth',
          'rightSideliteWidth',
        ].map((key) => [key, null]),
      ),
      prod: {
        name: 'Horizontal Rolling',
        kind: 'GLAZED_UNIT',
        diagramFamily: 'HORIZONTAL_SLIDER',
      },
      bran: { name: 'ECO' },
      syst: { name: '200' },
      conf: { conf: 'OX' },
      fColor: { color: 'Bronze' },
      activeOption: null,
      updatedAt: new Date('2026-09-21T00:00:00Z'),
    },
  ];
  const units: any[] = [];
  const stocks: any[] = [];
  let otherPo = false;
  const db: any = {
    order: {
      findUnique: jest.fn(async ({ where }) =>
        where.id === order.id
          ? order
          : where.poNumber && where.poNumber === order.poNumber
            ? order
            : otherPo
              ? { id: 2 }
              : null,
      ),
      update: jest.fn(async ({ data }) => {
        Object.assign(order, data, {
          updatedAt: new Date(order.updatedAt.getTime() + 1),
        });
        return order;
      }),
    },
    piece: {
      findMany: jest.fn(async () =>
        pieces.map((piece) => ({
          ...piece,
          factoryUnits: units.filter((unit) => unit.pieceId === piece.id),
        })),
      ),
    },
    factoryUnit: {
      findMany: jest.fn(async ({ where }) =>
        units
          .filter((unit) => where.lineNumber.in.includes(unit.lineNumber))
          .map((unit) => ({
            ...unit,
            piece: { idEst: unit.otherOrder ? 99 : 7 },
          })),
      ),
      createMany: jest.fn(async ({ data }) => {
        units.push(...data);
        return { count: data.length };
      }),
    },
    warehouseStock: {
      createMany: jest.fn(async ({ data }) => {
        const added = data.filter(
          (row) => !stocks.some((s) => s.lineNumber === row.lineNumber),
        );
        stocks.push(...added);
        return { count: added.length };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const quantityMatches = (stock, filter) => {
          if (filter.expectedParts === null)
            return stock.expectedParts === null;
          return (
            stock.expectedParts !== null &&
            stock.expectedParts !== filter.expectedParts.not
          );
        };
        const updated = stocks.filter(
          (stock) =>
            where.lineNumber.in.includes(stock.lineNumber) &&
            ['version', 'inTransit', 'onHand', 'released'].every(
              (field) =>
                where[field] === undefined ||
                (stock[field] ?? 0) === where[field],
            ) &&
            (!where.movements?.none || !stock.movements?.length) &&
            (!where.countLines?.none || !stock.countLines?.length) &&
            (where.OR
              ? where.OR.some((filter) => quantityMatches(stock, filter))
              : quantityMatches(stock, where)),
        );
        updated.forEach((stock) => Object.assign(stock, data));
        return { count: updated.length };
      }),
    },
    eventLog: { create: jest.fn(async () => ({ id: 1 })) },
    $transaction: jest.fn(async (callback) => callback(db)),
  };
  const service = new FactoryImportService(db);
  const preview = (buffer = file()) => service.preview(1, buffer, admin);
  const confirm = async (buffer = file(), overrides: any = {}) => {
    const p = await preview(buffer);
    return service.confirm(
      1,
      buffer,
      {
        revision: p.revision,
        assignments: JSON.stringify(
          p.lines.map((line) => ({
            lineNumber: line.lineNumber,
            pieceId: line.pieceId,
          })),
        ),
        ...overrides,
      },
      admin,
    );
  };
  return {
    db,
    order,
    pieces,
    units,
    stocks,
    service,
    preview,
    confirm,
    otherPo: () => {
      otherPo = true;
    },
  };
}

describe('factory JSON allowlist and measurements', () => {
  it('keeps only needed fields and exact exported cost', () => {
    const parsed = parseFactoryDocument(file());
    expect(Object.keys(parsed).sort()).toEqual([
      'factoryCost',
      'lines',
      'orderName',
      'poNumber',
    ]);
    expect(parsed.factoryCost).toBe('15651.724');
    expect(parsed.lines[0].height).toBe(59.5);
    expect(JSON.stringify(parsed)).not.toMatch(
      /email_domain|discounted_unit|Glass|Warehouse|999999/,
    );
  });
  it('accepts UTF-8 BOM and original fractions even without structured dimensions', () => {
    const doc = document();
    doc.lines[0].description = 'Window\nSize: 47 3/4 x 35 1/2';
    expect(
      parseFactoryDocument(Buffer.concat([Buffer.from('\ufeff'), file(doc)]))
        .lines[0],
    ).toMatchObject({ width: 47.75, height: 35.5 });
  });
  it.each([
    ['35 3/4', 35.75],
    ['35-3/4', 35.75],
    ['1/8', 0.125],
    ['1/0', null],
    ['abc', null],
  ])('parses %s', (value, expected) => {
    expect(inches(String(value))).toBe(expected);
  });
  it.each([undefined, Buffer.from('{'), Buffer.alloc(5 * 1024 * 1024 + 1)])(
    'rejects missing, malformed, or oversized JSON',
    (buffer) => {
      expect(() => parseFactoryDocument(buffer)).toThrow(BadRequestException);
    },
  );
  it.each([
    { currency: 'EUR' },
    { supplier: { id: 'OTHER' } },
    { schema: 'wrong' },
    { discounted_total: -1 },
    { discounted_total: null },
    { discounted_total: '1.123456789' },
    { discounted_total: '10000000000' },
    { po_number: Number.MAX_SAFE_INTEGER + 1 },
    { lines: [] },
  ])('rejects invalid header %p', (changes) => {
    expect(() =>
      parseFactoryDocument(file({ ...document(), ...changes })),
    ).toThrow(BadRequestException);
  });
  it('accepts a zero cost and numeric identifiers supplied as strings', () => {
    expect(
      parseFactoryDocument(
        file({ ...document(), po_number: '000123', discounted_total: 0 }),
      ).poNumber,
    ).toBe('123');
  });
  it('preserves eight cost decimals beyond JavaScript number precision', () => {
    const source = JSON.stringify(document()).replace(
      '15651.724',
      '1565172444.12345678',
    );
    expect(parseFactoryDocument(Buffer.from(source)).factoryCost).toBe(
      '1565172444.12345678',
    );
  });
  it('ignores nested amounts and rejects a duplicated header amount', () => {
    const source = JSON.stringify({
      ...document(),
      ignored: { discounted_total: 1 },
    });
    expect(parseFactoryDocument(Buffer.from(source)).factoryCost).toBe(
      '15651.724',
    );
    expect(() =>
      parseFactoryDocument(
        Buffer.from(
          source.replace(
            '"discounted_total":15651.724',
            '"discounted_total":1,"discounted_total":2',
          ),
        ),
      ),
    ).toThrow('duplicate');
  });
  it('rejects duplicate line numbers and quantities without separate identifiers', () => {
    expect(() =>
      parseFactoryDocument(file(document([factoryLine(), factoryLine()]))),
    ).toThrow('appears more than once');
    expect(() =>
      parseFactoryDocument(file(document([{ ...factoryLine(), qty: 2 }]))),
    ).toThrow('qty 1');
  });
});

describe('factory unit matching', () => {
  it('automatically assigns distinct codes to interchangeable units', () => {
    const rows = matchFactoryLines(
      parseFactoryDocument(
        file(document([factoryLine(100), factoryLine(101)])),
      ),
      [local({ qty: 2 })],
    );
    expect(rows.map((row) => row.pieceId)).toEqual([10, 10]);
  });
  it('fills identical local rows without asking which identical unit is which', () => {
    const rows = matchFactoryLines(
      parseFactoryDocument(
        file(document([factoryLine(100), factoryLine(101)])),
      ),
      [local(), local({ id: 11 })],
    );
    expect(rows.map((row) => row.pieceId)).toEqual([10, 11]);
  });
  it('does not assign above the local quantity', () => {
    const rows = matchFactoryLines(
      parseFactoryDocument(
        file(document([factoryLine(100), factoryLine(101)])),
      ),
      [local()],
    );
    expect(rows.map((row) => row.pieceId)).toEqual([10, null]);
  });
  it('does not confuse pieces that share a mark but differ in dimensions', () => {
    const rows = matchFactoryLines(parseFactoryDocument(file()), [
      local({ id: 11, width: 30, matchKey: 'other' }),
      local(),
    ]);
    expect(rows[0].pieceId).toBe(10);
  });
  it('requires review when candidates differ in attributes not proven by the JSON', () => {
    expect(
      matchFactoryLines(parseFactoryDocument(file()), [
        local(),
        local({ id: 11, matchKey: 'other-glass' }),
      ])[0].pieceId,
    ).toBeNull();
  });
  it.each([
    { mark: '' },
    { frameColor: 'White' },
    { width: 61 },
    { family: 'FRENCH_DOOR' },
    { configuration: 'XOX' },
    { active: 'Right Active' },
    { brand: 'Other' },
  ])('requires review for %p', (values) => {
    expect(
      matchingIssues(parseFactoryDocument(file()).lines[0], local(values))
        .length,
    ).toBeGreaterThan(0);
  });
  it('preserves existing links and reserves their quantity', () => {
    const rows = matchFactoryLines(
      parseFactoryDocument(
        file(document([factoryLine(101), factoryLine(100)])),
      ),
      [local({ lineNumbers: ['100'] })],
    );
    expect(rows[0].pieceId).toBeNull();
    expect(rows[1]).toMatchObject({ pieceId: 10, existing: true });
  });
});

describe('factory import transaction and authorization', () => {
  it('restricts the entire HTTP controller to admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, FactoryImportController)).toEqual([
      'admin',
    ]);
  });
  it.each(['client', 'dealer', 'operator'])(
    'rejects %s even when calling the service directly',
    async (name) => {
      const f = fixture();
      const actor = { id: 9, role: { name } } as any;
      await expect(f.service.get(1, actor)).rejects.toThrow(ForbiddenException);
      await expect(f.service.preview(1, file(), actor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(f.service.confirm(1, file(), {}, actor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(f.db.order.findUnique).not.toHaveBeenCalled();
    },
  );
  it('preview performs no writes', async () => {
    const f = fixture();
    const p = await f.preview();
    expect(p.lines[0].pieceId).toBe(10);
    expect(f.db.order.update).not.toHaveBeenCalled();
    expect(f.db.factoryUnit.createMany).not.toHaveBeenCalled();
  });
  it('stores only links and updates PO/cost/profit atomically without changing status', async () => {
    const f = fixture();
    const result = await f.confirm();
    expect(result).toMatchObject({ addedUnits: 1, linkedUnits: 1 });
    expect(f.units).toEqual([{ lineNumber: '100', pieceId: 10 }]);
    expect(f.order.poNumber).toBe('123');
    expect(f.order.rateReal?.toString()).toBe('15651.724');
    expect(f.order.netProfitReal?.toString()).toBe('4348.28');
    expect(f.order.statusId).toBe(1);
    expect(Object.keys(f.db.order.update.mock.calls[0][0].data).sort()).toEqual(
      ['netProfitReal', 'poNumber', 'rateReal'],
    );
    expect(f.db.$transaction.mock.calls[0][1].isolationLevel).toBe(
      'Serializable',
    );
    expect(f.db.eventLog.create).toHaveBeenCalledTimes(1);
  });
  it('reimport is idempotent and keeps linked identifiers', async () => {
    const f = fixture();
    await f.confirm();
    expect(await f.confirm()).toEqual({
      addedUnits: 0,
      linkedUnits: 1,
      unchanged: true,
    });
    expect(f.units).toHaveLength(1);
    expect(f.db.order.update).toHaveBeenCalledTimes(1);
  });
  it('accepts a revised cost from the same complete PO', async () => {
    const f = fixture();
    await f.confirm();
    await f.confirm(file({ ...document(), discounted_total: 15000.1234 }));
    expect(f.order.rateReal?.toString()).toBe('15000.1234');
    expect(f.units).toHaveLength(1);
  });
  it('keeps pending units when a reviewed import contains fewer lines', async () => {
    const f = fixture();
    f.pieces[0].qty = 2;
    await expect(f.confirm()).rejects.toThrow('Review the manual matches');
    expect(f.units).toHaveLength(0);
    await f.confirm(file(), { reviewed: 'true' });
    expect(f.units).toHaveLength(1);
    await f.confirm(file(document([factoryLine(100), factoryLine(101)])));
    expect(f.units).toHaveLength(2);
  });
  it('requires explicit review of manual matches', async () => {
    const f = fixture();
    f.pieces[0].mark = 'OTHER';
    const assignments = JSON.stringify([{ lineNumber: '100', pieceId: 10 }]);
    await expect(f.confirm(file(), { assignments })).rejects.toThrow(
      'Review the manual matches',
    );
    await f.confirm(file(), { assignments, reviewed: 'true' });
    expect(f.units).toHaveLength(1);
  });
  it('rejects a stale preview after the piece changes', async () => {
    const f = fixture();
    const p = await f.preview();
    f.pieces[0].qty = 2;
    await expect(
      f.service.confirm(
        1,
        file(),
        {
          revision: p.revision,
          assignments: JSON.stringify([{ lineNumber: '100', pieceId: 10 }]),
          reviewed: 'true',
        },
        admin,
      ),
    ).rejects.toThrow(ConflictException);
    expect(f.units).toHaveLength(0);
  });
  it('rejects PO or barcode conflicts with another order', async () => {
    const f = fixture();
    f.otherPo();
    await expect(f.preview()).rejects.toThrow('another order');
    const g = fixture();
    g.units.push({ lineNumber: '100', pieceId: 999, otherOrder: true });
    await expect(g.preview()).rejects.toThrow('another order');
  });
  it('never drops an existing link or swaps its PO', async () => {
    const f = fixture();
    await f.confirm();
    await expect(f.preview(file(document([factoryLine(101)])))).rejects.toThrow(
      'omits previously',
    );
    await expect(
      f.preview(file({ ...document(), po_number: 555 })),
    ).rejects.toThrow('different PO');
  });
  it('rejects duplicate assignments, foreign pieces and over-allocation', async () => {
    const f = fixture();
    await expect(
      f.confirm(file(), {
        assignments: '[{"lineNumber":"100","pieceId":999}]',
        reviewed: 'true',
      }),
    ).rejects.toThrow('belong to this order');
    await expect(
      f.confirm(file(), {
        assignments:
          '[{"lineNumber":"100","pieceId":10},{"lineNumber":"100","pieceId":10}]',
      }),
    ).rejects.toThrow('exactly once');
    await expect(
      f.confirm(file(document([factoryLine(100), factoryLine(101)])), {
        assignments:
          '[{"lineNumber":"100","pieceId":10},{"lineNumber":"101","pieceId":10}]',
        reviewed: 'true',
      }),
    ).rejects.toThrow('exceeds its quantity');
    expect(f.units).toHaveLength(0);
  });
  it('does not permit reassignment of an imported unit', async () => {
    const f = fixture();
    await f.confirm();
    f.pieces.push({ ...f.pieces[0], id: 11 });
    await expect(
      f.confirm(file(), {
        assignments: '[{"lineNumber":"100","pieceId":11}]',
        reviewed: 'true',
      }),
    ).rejects.toThrow('cannot be reassigned');
  });
  it('handles concurrent unique conflicts as a reviewable conflict', async () => {
    const f = fixture();
    f.db.factoryUnit.createMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.18.0',
      }),
    );
    await expect(f.confirm()).rejects.toThrow(ConflictException);
    expect(f.db.order.update).not.toHaveBeenCalled();
  });
});

describe('factory import expected physical parts', () => {
  it('uses structured panels plus one frame for an OX door without receiving stock', async () => {
    const f = fixture(),
      doc = document();
    f.pieces[0].prod = {
      name: 'French Door',
      kind: 'GLAZED_UNIT',
      diagramFamily: 'FRENCH_DOOR',
    };
    doc.lines[0].description =
      'Serie 200 French Door OX Bronze\nSize: 60 x 59 1/2\nPanels: 1';
    Object.assign(doc.lines[0].product_details, {
      configuration_id: 'FD200OX',
      panels: 2,
    });
    await f.confirm(file(doc));
    expect(f.stocks).toEqual([{ lineNumber: '100', expectedParts: 3 }]);
    expect(f.units).toEqual([{ lineNumber: '100', pieceId: 10 }]);
  });
  it('does not overwrite a reviewed stock quantity on reimport', async () => {
    const f = fixture();
    await f.confirm();
    f.stocks[0].expectedParts = 4;
    f.stocks[0].version = 1;
    await f.confirm();
    expect(f.stocks[0].expectedParts).toBe(4);
    expect(f.stocks).toHaveLength(1);
  });
  it('imports one horizontal rolling unit from panels: 1 without counting the OX letters', async () => {
    const f = fixture(),
      doc = document();
    f.pieces[0].panelCount = 2;
    Object.assign(doc.lines[0].product_details, { panels: 1 });
    await f.confirm(file(doc));
    expect(f.stocks[0].expectedParts).toBe(1);
  });
  it('uses a saved configuration count without deriving it from OX or the description', async () => {
    const f = fixture(),
      doc = document();
    f.pieces[0].conf.fixedPanelCount = 3;
    doc.lines[0].description += '\nPanels: 9';
    await f.confirm(file(doc));
    expect(f.stocks[0].expectedParts).toBe(3);
  });
  it('does not infer one part from a window family when all explicit counts are absent', async () => {
    const f = fixture();
    await f.confirm();
    expect(f.stocks[0].expectedParts).toBeNull();
  });
  it('corrects untouched quantities from the old rules when the JSON is reimported', async () => {
    const f = fixture(),
      doc = document();
    await f.confirm();
    f.stocks[0].expectedParts = 2;
    Object.assign(doc.lines[0].product_details, { panels: 1 });
    await f.confirm(file(doc));
    expect(f.stocks[0].expectedParts).toBe(1);
    expect(f.stocks).toHaveLength(1);
    expect(f.units).toEqual([{ lineNumber: '100', pieceId: 10 }]);
    f.db.order.update.mockClear();
    await f.confirm(file(doc));
    expect(f.db.order.update).not.toHaveBeenCalled();
  });
  it('clears an untouched inferred quantity if no numeric source exists on reimport', async () => {
    const f = fixture();
    await f.confirm();
    f.stocks[0].expectedParts = 1;
    await f.confirm();
    expect(f.stocks[0].expectedParts).toBeNull();
  });
  it.each([
    { version: 1 },
    { inTransit: 1 },
    { onHand: 1 },
    { released: 1 },
    { movements: [{ type: 'COUNT' }] },
    { countLines: [{ counted: 1 }] },
  ])(
    'preserves quantities with warehouse activity %j on reimport',
    async (activity) => {
      const f = fixture(),
        doc = document();
      await f.confirm();
      Object.assign(f.stocks[0], { expectedParts: 4 }, activity);
      Object.assign(doc.lines[0].product_details, { panels: 1 });
      await f.confirm(file(doc));
      expect(f.stocks[0].expectedParts).toBe(4);
    },
  );
});

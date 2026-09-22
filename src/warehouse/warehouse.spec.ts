import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import {
  barcodeLine,
  expectedPhysicalParts,
  assertBalances,
} from './warehouse-parts';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const door = '1029975',
  windowLine = '1029968';
const request = () => ({ requestKey: randomUUID() });
function fixture() {
  const f = warehouseFixture(),
    service = new WarehouseService(f.db);
  const scan = (
    action: 'COLLECT' | 'RECEIVE' | 'RELEASE',
    barcode = door,
    actor = admin,
  ) => service.scan({ ...request(), action, barcode, ...(action === 'COLLECT' ? {} : { storeId: 1 }) }, actor);
  return { ...f, service, scan };
}

describe('physical parts and factory barcode', () => {
  it.each(['I1096240', 'i1096240', '1096240', '  I01096240\r\n'])(
    'recognizes %s as the same factory unit',
    (value) => expect(barcodeLine(value)).toBe('1096240'),
  );
  it.each([
    'I',
    'X123',
    '0',
    'I12;DROP TABLE',
    '123 456',
    '',
    'I' + '1'.repeat(51),
  ])('rejects invalid code %s', (value) =>
    expect(() => barcodeLine(value)).toThrow(BadRequestException),
  );
  it('uses the saved count even when the configuration says OX', () =>
    expect(
      expectedPhysicalParts({
        family: 'FRENCH_DOOR',
        panelCount: 1,
      }),
    ).toBe(2));
  it('prefers structured factory panels for a sliding with a separate frame', () =>
    expect(
      expectedPhysicalParts(
        {
          family: 'SLIDING_DOOR',
          panelCount: 1,
          fixedPanelCount: 2,
        },
        3,
      ),
    ).toBe(4));
  it('receives the factory horizontal rolling as the one part specified by its JSON', () =>
    expect(
      expectedPhysicalParts(
        {
          family: 'HORIZONTAL_SLIDER',
          panelCount: 2,
        },
        1,
      ),
    ).toBe(1));
  it('uses an explicitly configured panel count when the JSON omits it', () =>
    expect(
      expectedPhysicalParts({
        family: 'FRENCH_DOOR',
        fixedPanelCount: 2,
      }),
    ).toBe(3));
  it('uses an explicit count for a generic product without guessing from its name', () => {
    const piece = {
      family: 'GENERIC',
      product: 'French Door',
      configuration: 'OX',
    };
    expect(expectedPhysicalParts(piece, 2)).toBe(2);
  });
  it.each([
    'FRENCH_DOOR',
    'SLIDING_DOOR',
    'HORIZONTAL_SLIDER',
    'SINGLE_HUNG',
    'FIXED_SHAPE',
    'CASEMENT',
    'LINEAR_MATERIAL',
    'PIVOT_DOOR',
    'BIFOLD',
    'GENERIC',
  ])(
    'does not invent a count for %s when no numeric source exists',
    (family) => {
      const piece = { family, product: 'French Door', configuration: 'OX' };
      expect(expectedPhysicalParts(piece)).toBeNull();
    },
  );
  it.each(['PIVOT_DOOR', 'BIFOLD', 'GENERIC', 'HORIZONTAL_SLIDER'])(
    'preserves explicit counts for %s without adding unconfirmed parts',
    (family) => expect(expectedPhysicalParts({ family }, 3)).toBe(3),
  );
  it.each([0, -1, 1.5, 200, NaN, Infinity])(
    'does not replace a missing count with invalid value %s',
    (panels) => {
      expect(
        expectedPhysicalParts({ family: 'SLIDING_DOOR' }, panels),
      ).toBeNull();
      expect(
        expectedPhysicalParts(
          { family: 'SLIDING_DOOR', fixedPanelCount: 2 },
          panels,
        ),
      ).toBe(3);
    },
  );
  it.each([
    { expectedParts: null, inTransit: 0, onHand: 0, released: 0 },
    { expectedParts: 3, inTransit: 0, onHand: -1, released: 0 },
    { expectedParts: 3, inTransit: 2, onHand: 1, released: 1 },
  ])('rejects invalid stock balances %j', (value) =>
    expect(() => assertBalances(value)).toThrow(BadRequestException),
  );
});

describe('warehouse movements', () => {
  it('protects every endpoint for staff and restricts expected-parts editing to admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, WarehouseController)).toEqual([
      'admin',
      'operator',
    ]);
    expect(
      Reflect.getMetadata(ROLES_KEY, WarehouseController.prototype.parts),
    ).toEqual(['admin']);
  });
  it.each(['client', 'dealer'])(
    'does not expose inventory or accept movements from %s',
    async (role) => {
      const f = fixture(),
        actor: any = { id: 3, role: { name: role } };
      await expect(f.service.inventory({}, actor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(f.service.inventoryByPo({}, actor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(f.service.history({}, actor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(f.service.counts(actor)).rejects.toThrow(ForbiddenException);
      await expect(
        f.service.scan(
          { ...request(), barcode: door, action: 'RECEIVE' },
          actor,
        ),
      ).rejects.toThrow(ForbiddenException);
    },
  );
  it('collects three shared-code parts into transit, then receives them into stock', async () => {
    const f = fixture();
    for (let n = 0; n < 3; n++) await f.scan('COLLECT');
    expect(await f.service.unit(door, admin)).toMatchObject({
      inTransit: 3,
      onHand: 0,
      pending: 0,
    });
    await expect(f.scan('COLLECT')).rejects.toThrow('already accounted');
    for (let n = 0; n < 3; n++) await f.scan('RECEIVE');
    expect(await f.service.unit(door, admin)).toMatchObject({
      inTransit: 0,
      onHand: 3,
      state: 'COMPLETE',
    });
    expect(f.movements).toHaveLength(6);
  });
  it('accepts a direct receipt and reports partial inventory', async () => {
    const f = fixture();
    const result = await f.scan('RECEIVE');
    expect(result.stock).toMatchObject({
      onHand: 1,
      expectedParts: 3,
      state: 'PARTIAL',
      pending: 2,
    });
    expect((await f.service.inventory({}, admin)).items).toHaveLength(1);
  });
  it('idempotently retries the same reading but allows distinct physical parts sharing a code', async () => {
    const f = fixture(),
      dto = { ...request(), barcode: door, action: 'RECEIVE' as const, storeId: 1 };
    await f.service.scan(dto, admin);
    expect((await f.service.scan(dto, admin)).replayed).toBe(true);
    await f.scan('RECEIVE');
    expect(f.stocks[0].onHand).toBe(2);
    expect(f.movements).toHaveLength(2);
    await expect(
      f.service.scan({ ...dto, action: 'COLLECT' }, admin),
    ).rejects.toThrow(ConflictException);
  });
  it('does not exceed available capacity when two readings arrive concurrently', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.scan('RECEIVE', windowLine),
      f.scan('RECEIVE', windowLine),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.stocks[2].onHand).toBe(1);
  });
  it('records a reversal without deleting the original movement', async () => {
    const f = fixture();
    const receipt = await f.scan('RECEIVE');
    const dto = request();
    await f.service.undo(receipt.movement.id, dto, admin);
    expect(f.stocks[0].onHand).toBe(0);
    expect(f.movements).toHaveLength(2);
    expect(
      (await f.service.history({}, admin)).items.find(
        (m) => m.id === receipt.movement.id,
      )?.reversed,
    ).toBe(true);
    expect(
      (await f.service.undo(receipt.movement.id, dto, admin)).replayed,
    ).toBe(true);
    await expect(
      f.service.undo(receipt.movement.id, request(), admin),
    ).rejects.toThrow('cannot be undone');
  });
  it('does not undo a reading after another movement on that unit', async () => {
    const f = fixture();
    const first = await f.scan('COLLECT');
    await f.scan('RECEIVE');
    await expect(
      f.service.undo(first.movement.id, request(), admin),
    ).rejects.toThrow('newer movements');
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, onHand: 1 });
  });
  it('prevents an operator from undoing someone else’s reading', async () => {
    const f = fixture();
    const first = await f.scan('RECEIVE');
    await expect(
      f.service.undo(first.movement.id, request(), operator),
    ).rejects.toThrow(ForbiddenException);
  });
  it('rejects unimported barcodes without writing stock or movements', async () => {
    const f = fixture();
    await expect(f.scan('RECEIVE', 'I999999')).rejects.toThrow(
      NotFoundException,
    );
    expect(f.movements).toHaveLength(0);
  });
  it('rolls back stock when recording its audit movement fails', async () => {
    const f = fixture();
    f.db.warehouseMovement.create = async () => {
      throw new Error('Database failure');
    };
    await expect(f.scan('RECEIVE')).rejects.toThrow('Database failure');
    expect(f.stocks[0].onHand).toBe(0);
    expect(f.stocks[0].version).toBe(0);
  });
  it('uses explicit configuration counts for old imported units without creating physical stock during lookup', async () => {
    const f = fixture();
    f.stocks[0].expectedParts = null;
    f.pieces[0].conf.fixedPanelCount = 2;
    expect((await f.service.unit(door, admin)).expectedParts).toBe(3);
    expect(f.stocks[0].expectedParts).toBeNull();
    await f.scan('RECEIVE');
    expect(f.stocks[0].expectedParts).toBe(3);
  });
  it('leaves an OX unit with no explicit count pending until admin defines its physical parts', async () => {
    const f = fixture();
    f.stocks[0].expectedParts = null;
    expect((await f.service.unit(door, admin)).expectedParts).toBeNull();
    await expect(f.scan('RECEIVE')).rejects.toThrow('expected physical parts');
    const dto = {
      ...request(),
      version: 0,
      expectedParts: 3,
      reason: 'Packaging verified',
    };
    await expect(f.service.setParts(door, dto, operator)).rejects.toThrow(
      ForbiddenException,
    );
    await f.service.setParts(door, dto, admin);
    expect(f.stocks[0]).toMatchObject({ expectedParts: 3, onHand: 0 });
    expect(f.movements[0].type).toBe('PARTS');
  });
  it('rejects stale expected-part edits and totals smaller than accounted stock', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    await f.scan('RECEIVE');
    await expect(
      f.service.setParts(
        door,
        { ...request(), version: 0, expectedParts: 4, reason: 'New count' },
        admin,
      ),
    ).rejects.toThrow(ConflictException);
    await expect(
      f.service.setParts(
        door,
        { ...request(), version: 2, expectedParts: 1, reason: 'New count' },
        admin,
      ),
    ).rejects.toThrow('already accounted');
  });
  it('releases on-hand parts without silently completing the customer order', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    await f.scan('RELEASE');
    expect(f.stocks[0]).toMatchObject({ onHand: 0, released: 1 });
    expect(f.order.status.name).toBe('Ready to pick up');
    await expect(f.scan('RELEASE')).rejects.toThrow('no parts');
  });
  it('blocks outgoing parts when the existing payment requirements are not met', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    f.order.payment.status = 'PENDING';
    await expect(f.scan('RELEASE')).rejects.toThrow('payment');
    expect(f.stocks[0].onHand).toBe(1);
    expect(f.movements).toHaveLength(1);
  });
  it('groups inventory by factory PO and paginates POs without losing their lines', async () => {
    const f = fixture();
    f.pieces[3].estim.order = {
      ...f.pieces[3].estim.order,
      id: 2,
      number: '1002',
      poNumber: '381922',
    };
    const first = await f.service.inventoryByPo(
      { view: 'all', pageSize: '1', page: '1' },
      admin,
    );
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      poNumber: '281374',
      orderNumber: '1001',
    });
    expect(first.items[0].units.map((unit) => unit.lineNumber)).toEqual([
      '1029967',
      windowLine,
      door,
    ]);
    const second = await f.service.inventoryByPo(
      { view: 'all', pageSize: '1', page: '2' },
      admin,
    );
    expect(second.items[0]).toMatchObject({
      poNumber: '381922',
      orderNumber: '1002',
    });
    expect(second.items[0].units.map((unit) => unit.lineNumber)).toEqual([
      '1096240',
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /rateReal|discounted_total|password|width|height/,
    );
  });

  it('filters and paginates inventory without exposing financial or product duplicates', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    await f.scan('RECEIVE', windowLine);
    expect(
      (await f.service.inventory({ view: 'partial' }, admin)).items.map(
        (r) => r.lineNumber,
      ),
    ).toEqual([door]);
    expect(
      (await f.service.inventory({ view: 'complete' }, admin)).items.map(
        (r) => r.lineNumber,
      ),
    ).toEqual([windowLine]);
    expect(
      (await f.service.inventory({ view: 'all', search: 'I1029975' }, admin))
        .items,
    ).toHaveLength(1);
    const paged = await f.service.inventory(
      { view: 'all', pageSize: '1', page: '2' },
      admin,
    );
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(4);
    expect(JSON.stringify(paged)).not.toMatch(
      /rateReal|discounted_total|password|width|height/,
    );
  });
});

describe('warehouse release eligibility', () => {
  it.each(['Pending', 'In production'])(
    'rejects stock release while the order is %s',
    async (status) => {
      const f = fixture();
      await f.scan('RECEIVE');
      f.order.status.name = status;
      await expect(f.scan('RELEASE')).rejects.toThrow('ready for pickup');
      expect(f.stocks[0].onHand).toBe(1);
    },
  );
  it('requires fulfillment selection before stock leaves', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    f.order.fulfillmentMethod = 'UNDECIDED';
    await expect(f.scan('RELEASE')).rejects.toThrow(
      'Choose Pickup or Delivery',
    );
  });
  it('requires covered delivery payment for company delivery', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    f.order.fulfillmentMethod = 'COMPANY_DELIVERY';
    await expect(f.scan('RELEASE')).rejects.toThrow('Delivery payment');
    f.order.deliveries.push({
      status: 'SCHEDULED',
      payment: { status: 'PAID' },
    } as never);
    await f.scan('RELEASE');
    expect(f.stocks[0].released).toBe(1);
  });
});

describe('physical inventory count', () => {
  it('starts once and pauses movements while preserving the physical inventory', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const dto = { ...request(), scope: 'STORE' as const, storeId: 1 },
      count = await f.service.startCount(dto, operator);
    expect(await f.service.startCount(dto, operator)).toEqual(count);
    await expect(f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin)).rejects.toThrow(
      'is open',
    );
    await expect(f.scan('RECEIVE')).rejects.toThrow('is open');
    const result = await f.service.countScan(
      count.id,
      { ...request(), barcode: door },
      operator,
    );
    expect(result.counted).toBe(1);
    expect(f.stocks[0].onHand).toBe(1);
    expect(f.stocks[0].version).toBe(1);
  });
  it('retries and reverses count readings without affecting stock', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator),
      dto = { ...request(), barcode: door };
    const result = await f.service.countScan(count.id, dto, operator);
    expect((await f.service.countScan(count.id, dto, operator)).counted).toBe(
      1,
    );
    await f.service.undo(result.movement.id, request(), operator);
    expect(f.countLines[0].counted).toBe(0);
    expect(f.stocks[0].onHand).toBe(1);
  });
  it('permits a staff member to close a count with no differences', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator);
    await f.service.countScan(
      count.id,
      { ...request(), barcode: door },
      operator,
    );
    const review = await f.service.count(count.id, {}, operator);
    await f.service.closeCount(
      count.id,
      { action: 'COMPLETE', revision: review.revision },
      operator,
    );
    expect(f.counts[0].status).toBe('COMPLETED');
    expect(f.movements.filter((m) => m.type === 'ADJUST')).toHaveLength(0);
    await f.scan('RECEIVE');
  });
  it('requires an administrator and a reason for adjustments, then records them atomically', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator);
    await f.service.countScan(
      count.id,
      { ...request(), barcode: door },
      operator,
    );
    const review = await f.service.count(count.id, {}, admin);
    expect(review).toMatchObject({ expected: 2, counted: 1, differences: 1 });
    const dto = {
      action: 'COMPLETE' as const,
      revision: review.revision,
      reason: 'Verified missing part',
    };
    await expect(f.service.closeCount(count.id, dto, operator)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      f.service.closeCount(count.id, { ...dto, reason: '' }, admin),
    ).rejects.toThrow('reason');
    await f.service.closeCount(count.id, dto, admin);
    expect(f.stocks[0].onHand).toBe(1);
    expect(f.movements[f.movements.length - 1]).toMatchObject({
      type: 'ADJUST',
      onHandDelta: -1,
      countId: count.id,
    });
    await f.service.closeCount(count.id, dto, admin);
    expect(f.movements.filter((m) => m.type === 'ADJUST')).toHaveLength(1);
  });
  it('rejects a stale count review if another person scans after it was reviewed', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator),
      before = await f.service.count(count.id, {}, admin);
    await f.service.countScan(
      count.id,
      { ...request(), barcode: door },
      operator,
    );
    await expect(
      f.service.closeCount(
        count.id,
        { action: 'COMPLETE', revision: before.revision, reason: 'Reviewed' },
        admin,
      ),
    ).rejects.toThrow('changed');
    expect(f.counts[0].status).toBe('OPEN');
  });
  it('tracks found stock that was recorded at zero, with admin review before an adjustment', async () => {
    const f = fixture();
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    await f.service.countScan(
      count.id,
      { ...request(), barcode: windowLine },
      admin,
    );
    const review = await f.service.count(count.id, {}, admin);
    expect(review).toMatchObject({ expected: 0, counted: 1, differences: 1 });
    expect(f.stocks[2].onHand).toBe(0);
    await f.service.closeCount(
      count.id,
      {
        action: 'COMPLETE',
        revision: review.revision,
        reason: 'Unrecorded physical stock verified',
      },
      admin,
    );
    expect(f.stocks[2].onHand).toBe(1);
  });
  it('cancels without changing stock and disallows further readings', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator);
    await f.service.closeCount(count.id, { action: 'CANCEL' }, operator);
    expect(f.stocks[0].onHand).toBe(1);
    await expect(
      f.service.countScan(count.id, { ...request(), barcode: door }, operator),
    ).rejects.toThrow('closed');
    await f.scan('RECEIVE');
  });
  it('does not count transit parts as warehouse stock or exceed the shared barcode capacity', async () => {
    const f = fixture();
    await f.scan('COLLECT', windowLine);
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    await expect(
      f.service.countScan(
        count.id,
        { ...request(), barcode: windowLine },
        admin,
      ),
    ).rejects.toThrow('exceeds');
    expect(f.stocks[2]).toMatchObject({ onHand: 0, inTransit: 1 });
  });
  it('rolls back both adjustments and closure when an audit write fails', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin),
      review = await f.service.count(count.id, {}, admin);
    f.db.warehouseMovement.create = async () => {
      throw new Error('Audit failure');
    };
    await expect(
      f.service.closeCount(
        count.id,
        {
          action: 'COMPLETE',
          revision: review.revision,
          reason: 'Part missing',
        },
        admin,
      ),
    ).rejects.toThrow('Audit failure');
    expect(f.stocks[0].onHand).toBe(1);
    expect(f.counts[0].status).toBe('OPEN');
  });
});

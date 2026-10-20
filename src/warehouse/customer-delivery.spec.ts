import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';
import { WarehouseCustomerDeliveryDto } from './warehouse.dto';
import { customerDeliverySignature } from './customer-delivery-signature';

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const signature = () => [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];
const door = '1029975', fixed = '1096240';

function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  f.stocks[0].inTransit = 3;
  f.stocks[3].inTransit = 1;
  const dto = (changes: Partial<WarehouseCustomerDeliveryDto> = {}): WarehouseCustomerDeliveryDto => ({
    requestKey: randomUUID(), source: 'TRANSIT', firstName: 'Maria', lastName: 'Recipient',
    signatureStrokes: signature(), items: [{ barcode: door, quantity: 2, version: 0 }], ...changes,
  });
  const snapshot = () => structuredClone({
    stocks: f.stocks, balances: f.balances, movements: f.movements, deliveries: f.customerDeliveries,
  });
  const warehouse = (quantity = 3, storeId: number | null = 1) => {
    f.stocks[0].inTransit = 0; f.stocks[0].onHand = quantity;
    if (storeId === null) f.stocks[0].unassigned = quantity;
    else f.balances.push({ lineNumber: door, storeId, onHand: quantity });
  };
  const external = () => {
    f.externalPos.push({ id: 8, poNumber: '292427', orderName: 'Santos', supplierName: 'Factory' });
    Object.assign(f.stocks[3], { pieceId: null, externalPoId: 8, description: 'External window', mark: 'EXT' });
  };
  return { ...f, service, dto, snapshot, warehouse, external };
}

describe('signed customer deliveries', () => {
  it('releases already scanned parts directly from transit, without warehouse receipt or a second scan', async () => {
    const f = fixture();
    const delivery = await f.service.deliverToCustomer(f.dto(), admin);
    expect(delivery).toMatchObject({ source: 'TRANSIT', storeId: null, storeName: null, firstName: 'Maria', lastName: 'Recipient', totalPieces: 1, totalParts: 2, actor: 'Admin Test', replayed: false });
    expect(f.stocks[0]).toMatchObject({ inTransit: 1, onHand: 0, unassigned: 0, released: 2, version: 1 });
    expect(f.movements).toHaveLength(1);
    expect(f.movements[0]).toMatchObject({ type: 'RELEASE', customerDeliveryId: delivery.id, quantity: 2, transitDelta: -2, onHandDelta: 0, releasedDelta: 2, fromStoreId: null, toStoreId: null });
    expect(f.balances).toHaveLength(0);
    expect(f.order.status.name).toBe('Ready to pick up');
  });

  it('releases selected-store quantities and leaves other stores and transit unchanged', async () => {
    const f = fixture(); f.warehouse(2);
    f.stocks[0].onHand = 3;
    f.balances.push({ lineNumber: door, storeId: 2, onHand: 1 });
    const delivery = await f.service.deliverToCustomer(f.dto({ source: 'WAREHOUSE', storeId: 1 }), operator);
    expect(delivery).toMatchObject({ source: 'WAREHOUSE', storeId: 1, storeName: 'Main', totalParts: 2, actor: 'Operator Test' });
    expect(f.stocks[0]).toMatchObject({ onHand: 1, inTransit: 0, released: 2 });
    expect(f.balances.map((row) => row.onHand)).toEqual([0, 1]);
    expect(f.movements[0]).toMatchObject({ fromStoreId: 1, onHandDelta: -2, transitDelta: 0 });
  });

  it('supports an explicitly selected Unassigned source', async () => {
    const f = fixture(); f.warehouse(3, null);
    expect(await f.service.deliverToCustomer(f.dto({ source: 'WAREHOUSE', storeId: null }), admin)).toMatchObject({ storeName: 'Unassigned' });
    expect(f.stocks[0]).toMatchObject({ onHand: 1, unassigned: 1, released: 2 });
  });

  it('records multiple internal and external POs in one immutable receipt', async () => {
    const f = fixture(); f.external();
    const dto = f.dto({ firstName: '  Maria   Elena ', lastName: '  Test ', items: [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }] });
    const result = await f.service.deliverToCustomer(dto, admin);
    expect(result).toMatchObject({ firstName: 'Maria Elena', lastName: 'Test', totalPieces: 2, totalParts: 3, signatureStrokes: signature() });
    expect(result.items).toMatchObject([
      { lineNumber: door, barcode: `I${door}`, poNumber: '281374', source: 'ORDER', orderNumber: '1001', mark: 'F3', description: 'French Door · ECO · OX', quantity: 2 },
      { lineNumber: fixed, poNumber: '292427', source: 'EXTERNAL', orderNumber: '', description: 'External window', quantity: 1 },
    ]);
    expect(f.movements.every((row) => row.customerDeliveryId === result.id)).toBe(true);
    f.externalPos[0].poNumber = 'CHANGED'; f.stocks[3].description = 'Changed description';
    f.pieces[0].prod.name = 'Changed product'; f.users[0].firstName = 'Renamed';
    const { replayed: _, ...receipt } = result;
    expect(await f.service.customerDelivery(result.id, operator)).toEqual(receipt);
  });

  it('retains the original store name after its location is renamed', async () => {
    const f = fixture(); f.warehouse();
    const result = await f.service.deliverToCustomer(f.dto({ source: 'WAREHOUSE', storeId: 1 }), admin);
    f.stores[0].name = 'Renamed';
    expect(await f.service.customerDelivery(result.id, admin)).toMatchObject({ storeName: 'Main' });
  });

  it('replays a lost response with its saved signature and no second stock movement', async () => {
    const f = fixture(), dto = f.dto({ items: [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }] });
    const result = await f.service.deliverToCustomer(dto, admin), before = f.snapshot();
    expect(await f.service.deliverToCustomer({ ...dto, items: [...dto.items].reverse() }, admin)).toEqual({ ...result, replayed: true });
    expect(f.snapshot()).toEqual(before);
  });

  it('binds idempotency to actor, source, quantities, recipient, signature and version', async () => {
    const f = fixture(), dto = f.dto();
    await f.service.deliverToCustomer(dto, admin);
    const before = f.snapshot();
    const changedSignature = signature(); changedSignature[0][0].x = 0.12;
    for (const changes of [
      { firstName: 'Other' }, { lastName: 'Other' }, { signatureStrokes: changedSignature },
      { source: 'WAREHOUSE' as const, storeId: 1 },
      { items: [{ ...dto.items[0], quantity: 1 }] }, { items: [{ ...dto.items[0], version: 1 }] },
    ]) await expect(f.service.deliverToCustomer({ ...dto, ...changes }, admin)).rejects.toThrow('another operation');
    await expect(f.service.deliverToCustomer(dto, operator)).rejects.toThrow('another operation');
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects a key already used by a different warehouse movement', async () => {
    const f = fixture(), dto = f.dto();
    await f.service.scan({ requestKey: dto.requestKey, barcode: door, partType: 'DOOR', action: 'RECEIVE', storeId: 1 }, admin);
    const before = f.snapshot();
    await expect(f.service.deliverToCustomer(dto, admin)).rejects.toThrow('another operation');
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects stale selections without releasing anything or saving a signature', async () => {
    const f = fixture(); f.stocks[3].version = 1;
    const before = f.snapshot();
    await expect(f.service.deliverToCustomer(f.dto({ items: [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }] }), admin)).rejects.toThrow('changed');
    expect(f.snapshot()).toEqual(before);
  });

  it('rolls back receipt, stock and all audit rows when a later movement fails', async () => {
    const f = fixture(), before = f.snapshot();
    const create = f.db.warehouseMovement.create; let calls = 0;
    f.db.warehouseMovement.create = async (args) => { if (++calls === 2) throw new Error('Audit failure'); return create(args); };
    await expect(f.service.deliverToCustomer(f.dto({ items: [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }] }), admin)).rejects.toThrow('Audit failure');
    expect(f.snapshot()).toEqual(before);
  });

  it('allows only one competing delivery for the same stock version', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.deliverToCustomer(f.dto(), admin), f.service.deliverToCustomer(f.dto(), operator)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.customerDeliveries).toHaveLength(1);
    expect(f.stocks[0]).toMatchObject({ inTransit: 1, released: 2 });
  });

  it('replays simultaneous identical submissions instead of duplicating delivery', async () => {
    const f = fixture(), dto = f.dto();
    const results = await Promise.all([f.service.deliverToCustomer(dto, admin), f.service.deliverToCustomer(dto, admin)]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(f.customerDeliveries).toHaveLength(1);
  });

  it.each(['TRANSIT', 'WAREHOUSE'] as const)('requires enough actual %s stock and does not silently receive missing parts', async (source) => {
    const f = fixture();
    if (source === 'WAREHOUSE') f.warehouse(1);
    else f.stocks[0].inTransit = 1;
    const before = f.snapshot();
    await expect(f.service.deliverToCustomer(f.dto({ source, ...(source === 'WAREHOUSE' ? { storeId: 1 } : {}) }), admin)).rejects.toThrow('that many parts');
    expect(f.snapshot()).toEqual(before);
  });

  it('never consumes a different store just because global warehouse stock is sufficient', async () => {
    const f = fixture(); f.warehouse(3, 2);
    await expect(f.service.deliverToCustomer(f.dto({ source: 'WAREHOUSE', storeId: 1 }), admin)).rejects.toThrow('source store');
    expect(f.stocks[0].released).toBe(0);
  });

  it('blocks stock departures during a physical count', async () => {
    const f = fixture(); f.counts.push({ id: 15, activeSlot: 1 });
    await expect(f.service.deliverToCustomer(f.dto(), admin)).rejects.toThrow('Physical count');
    expect(f.customerDeliveries).toHaveLength(0);
  });

  it('preserves payment restrictions for internal orders before saving a mixed receipt', async () => {
    const f = fixture(); f.external(); f.order.payment.status = 'PENDING';
    const before = f.snapshot();
    await expect(f.service.deliverToCustomer(f.dto({ items: [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }] }), admin)).rejects.toThrow('Material payment');
    expect(f.snapshot()).toEqual(before);
  });

  it('requires a ready internal order while external-only stock needs no commercial owner', async () => {
    const f = fixture(); f.order.status.name = 'Draft';
    await expect(f.service.deliverToCustomer(f.dto(), admin)).rejects.toThrow('ready');
    f.external();
    expect(await f.service.deliverToCustomer(f.dto({ items: [{ barcode: fixed, quantity: 1, version: 0 }] }), admin)).toMatchObject({ totalParts: 1 });
  });

  it('does not tear a signed receipt apart through the generic per-line undo', async () => {
    const f = fixture(); await f.service.deliverToCustomer(f.dto(), admin);
    const before = f.snapshot();
    await expect(f.service.undo(f.movements[0].id, { requestKey: randomUUID() }, admin)).rejects.toThrow('signed customer delivery');
    expect(f.snapshot()).toEqual(before);
    expect((await f.service.history({}, admin)).items[0]).toMatchObject({ customerDeliveryId: f.customerDeliveries[0].id });
  });

  it('keeps an unsigned installation release compatible with the existing scan and undo flow', async () => {
    const f = fixture(); f.warehouse();
    const result = await f.service.scan({ requestKey: randomUUID(), action: 'RELEASE', barcode: door, storeId: 1 }, admin);
    expect(result.movement.customerDeliveryId).toBeNull();
    await f.service.undo(result.movement.id, { requestKey: randomUUID() }, admin);
    expect(f.stocks[0]).toMatchObject({ onHand: 3, released: 0 });
    expect(f.customerDeliveries).toHaveLength(0);
  });

  it.each(['client', 'dealer', 'technician'] as const)('prevents %s from accessing or creating signed warehouse deliveries', async (role) => {
    const f = fixture(), actor = { id: 3, role: { name: role } };
    await expect(f.service.deliverToCustomer(f.dto(), actor)).rejects.toThrow(ForbiddenException);
    await expect(f.service.customerDelivery(1, actor)).rejects.toThrow(ForbiddenException);
  });

  it('reports missing receipts without disclosing other records', async () => {
    await expect(fixture().service.customerDelivery(999, admin)).rejects.toThrow(NotFoundException);
  });

  it.each([
    { source: 'UNKNOWN' }, { source: 'WAREHOUSE' }, { source: 'WAREHOUSE', storeId: 0 },
    { source: 'TRANSIT', storeId: 1 }, { firstName: '  ' }, { lastName: ' ' },
    { firstName: 'A'.repeat(101) }, { lastName: 'B'.repeat(101) }, { requestKey: '' },
    { items: [] }, { items: [null] }, { items: [{ barcode: door, quantity: 0, version: 0 }] },
    { items: [{ barcode: door, quantity: 201, version: 0 }] }, { items: [{ barcode: door, quantity: 1.5, version: 0 }] },
    { items: [{ barcode: door, quantity: 1, version: -1 }] }, { items: [{ barcode: door, quantity: 1, version: 0 }, { barcode: `I0${door}`, quantity: 1, version: 0 }] },
  ])('validates malformed input before making stock changes: %j', async (changes) => {
    const f = fixture(), before = f.snapshot();
    await expect(f.service.deliverToCustomer(f.dto(changes as any), admin)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  });

  it('validates required HTTP fields and nested batch quantities', async () => {
    const f = fixture();
    expect(await validate(plainToInstance(WarehouseCustomerDeliveryDto, f.dto()))).toHaveLength(0);
    expect(await validate(plainToInstance(WarehouseCustomerDeliveryDto, f.dto({ items: [{ barcode: door, quantity: -1, version: 0 }] })))).not.toHaveLength(0);
  });
});

describe('recipient signature validation', () => {
  it('accepts normalized meaningful strokes and discards extra point fields', () => {
    const input: any = signature(); input[0][0].untrusted = '<script>';
    expect(customerDeliverySignature(input)).toEqual(signature());
  });
  it.each([undefined, null, [], [[]], [[{ x: 0.1, y: 0.1 }]], [[{ x: -1, y: 0.5 }]], [[{ x: 0.5, y: Infinity }]], [[{ x: '0.5', y: 0.5 }]], [Array.from({ length: 5 }, () => ({ x: 0.5, y: 0.5 }))]].map((value) => ({ value })))('rejects empty, malformed or trivial signature %j', ({ value }) => {
    expect(() => customerDeliverySignature(value)).toThrow();
  });
  it('bounds stroke and total-point counts', () => {
    expect(() => customerDeliverySignature(Array.from({ length: 101 }, () => signature()[0]))).toThrow();
    expect(() => customerDeliverySignature([Array.from({ length: 3001 }, () => ({ x: 0.1, y: 0.1 }))])).toThrow();
    expect(() => customerDeliverySignature(Array.from({ length: 2 }, () => Array.from({ length: 2501 }, () => ({ x: 0.1, y: 0.1 }))))).toThrow();
  });
});

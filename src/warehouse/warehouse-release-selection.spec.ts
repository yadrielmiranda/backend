import { createHash, randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseController } from './warehouse.controller';
import { WarehouseReleaseDto } from './warehouse.dto';
import { WarehouseService } from './warehouse.service';

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const door = '1029975', fixed = '1096240';

function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  f.stocks[0].onHand = 3;
  f.balances.push({ lineNumber: door, storeId: 1, onHand: 3 });
  f.stocks[3].onHand = 1;
  f.balances.push({ lineNumber: fixed, storeId: 1, onHand: 1 });
  const dto = (changes: Partial<WarehouseReleaseDto> = {}): WarehouseReleaseDto => ({
    requestKey: randomUUID(), storeId: 1, items: [{ barcode: door, quantity: 2, version: 0 }], ...changes,
  });
  const both = () => [{ barcode: door, quantity: 2, version: 0 }, { barcode: fixed, quantity: 1, version: 0 }];
  const snapshot = () => structuredClone({ stocks: f.stocks, balances: f.balances, movements: f.movements, deliveries: f.customerDeliveries });
  const external = () => {
    f.externalPos.push({ id: 8, poNumber: '292427', orderName: 'Santos', supplierName: 'Factory' });
    Object.assign(f.stocks[3], { pieceId: null, externalPoId: 8, description: 'External window' });
  };
  return { ...f, service, dto, both, snapshot, external };
}

describe('manual warehouse release selection', () => {
  it('releases quantities without a signature, customer receipt or assigned installation', async () => {
    const f = fixture(), dto = f.dto();
    expect(await f.service.release(dto, admin)).toEqual({ units: 1, parts: 2, storeId: 1, storeName: 'Main', replayed: false });
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, onHand: 1, unassigned: 0, released: 2, version: 1 });
    expect(f.movements).toHaveLength(1);
    expect(f.movements[0]).toMatchObject({ requestKey: dto.requestKey, type: 'RELEASE', actorId: 1, quantity: 2, transitDelta: 0, onHandDelta: -2, releasedDelta: 2, fromStoreId: 1, toStoreId: null, installationJobId: null, customerDeliveryId: null });
    expect(f.customerDeliveries).toHaveLength(0);
    expect(f.order.status.name).toBe('Ready to pick up');
  });

  it('debits only the selected store, leaving transit and other locations unchanged', async () => {
    const f = fixture();
    Object.assign(f.stocks[0], { onHand: 2, inTransit: 1 });
    f.balances[0].onHand = 1;
    f.balances.push({ lineNumber: door, storeId: 2, onHand: 1 });
    await f.service.release(f.dto({ items: [{ barcode: door, quantity: 1, version: 0 }] }), operator);
    expect(f.stocks[0]).toMatchObject({ onHand: 1, inTransit: 1, released: 1 });
    expect(f.balances.filter((b) => b.lineNumber === door).map((b) => b.onHand)).toEqual([0, 1]);
    expect(f.movements[0].actorId).toBe(2);
  });

  it('supports an explicit Unassigned source without assigning stock to a store', async () => {
    const f = fixture(); f.balances.splice(0, 1); f.stocks[0].unassigned = 3;
    expect(await f.service.release(f.dto({ storeId: null }), admin)).toMatchObject({ storeId: null, storeName: 'Unassigned' });
    expect(f.stocks[0]).toMatchObject({ onHand: 1, unassigned: 1, released: 2 });
    expect(f.movements[0].fromStoreId).toBeNull();
  });

  it('accepts a mixed internal-order and external-PO selection and creates deterministic audit keys', async () => {
    const f = fixture(); f.external(); const dto = f.dto({ items: f.both().reverse() });
    expect(await f.service.release(dto, admin)).toMatchObject({ units: 2, parts: 3 });
    expect(f.movements.map((row) => [row.lineNumber, row.quantity])).toEqual([[door, 2], [fixed, 1]]);
    expect(f.movements.map((row) => row.requestKey)).toEqual([dto.requestKey, createHash('sha256').update(JSON.stringify([dto.requestKey, fixed])).digest('hex')]);
    expect(f.customerDeliveries).toHaveLength(0);
  });

  it('attaches an available installation using the same commercial release policy as scan', async () => {
    const f = fixture();
    f.order.fulfillmentMethod = 'INSTALLATION_DELIVERY';
    f.order.status.name = 'Preparing for pickup';
    f.order.estimate.installationJob = {
      id: 71, status: 'SCHEDULED', installationAddress: { street: '123 Test Street', city: 'Miami', state: 'FL', postalCode: '33101' },
      quotes: [{ status: 'APPROVED', total: 0, lines: [] }], payments: [],
    };
    await f.service.release(f.dto(), admin);
    expect(f.movements[0]).toMatchObject({ installationJobId: 71, installationAddress: '123 Test Street, Miami, FL 33101' });
    expect(f.order.estimate.installationJob.status).toBe('SCHEDULED');
  });

  it('remains compatible with per-line undo for unsigned releases', async () => {
    const f = fixture(); await f.service.release(f.dto(), operator);
    await f.service.undo(f.movements[0].id, { requestKey: randomUUID() }, operator);
    expect(f.stocks[0]).toMatchObject({ onHand: 3, released: 0 });
    expect(f.balances[0].onHand).toBe(3);
    expect(f.customerDeliveries).toHaveLength(0);
  });

  it('replays the original summary after source renaming, payload reordering and a new physical count', async () => {
    const f = fixture(), dto = f.dto({ items: f.both() });
    const result = await f.service.release(dto, admin);
    f.stores[0].name = 'Renamed'; f.counts.push({ id: 15, activeSlot: 1 });
    const before = f.snapshot();
    expect(await f.service.release({ ...dto, items: [...dto.items].reverse() }, admin)).toEqual({ ...result, replayed: true });
    expect(f.snapshot()).toEqual(before);
  });

  it('binds the request to actor, store, line selection, quantities and versions', async () => {
    const f = fixture(), dto = f.dto(); await f.service.release(dto, admin);
    const before = f.snapshot();
    for (const changes of [
      { storeId: 2 }, { storeId: null },
      { items: [{ ...dto.items[0], barcode: fixed }] },
      { items: [{ ...dto.items[0], quantity: 1 }] },
      { items: [{ ...dto.items[0], version: 1 }] },
    ]) await expect(f.service.release({ ...dto, ...changes }, admin)).rejects.toThrow('another operation');
    await expect(f.service.release(dto, operator)).rejects.toThrow('another operation');
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects a key already used by another warehouse movement', async () => {
    const f = fixture(), dto = f.dto();
    await f.service.scan({ requestKey: dto.requestKey, barcode: door, action: 'RELEASE', storeId: 1 }, admin);
    const before = f.snapshot();
    await expect(f.service.release(dto, admin)).rejects.toThrow('another operation');
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects a key owned by a customer receipt even without a corresponding movement', async () => {
    const f = fixture(), dto = f.dto(); f.customerDeliveries.push({ requestKey: dto.requestKey, requestHash: 'other operation' });
    const before = f.snapshot();
    await expect(f.service.release(dto, admin)).rejects.toThrow('another operation');
    expect(f.snapshot()).toEqual(before);
  });

  it('handles simultaneous identical submissions with one release and one replay', async () => {
    const f = fixture(), dto = f.dto();
    const results = await Promise.all([f.service.release(dto, admin), f.service.release(dto, admin)]);
    expect(results.filter((row) => row.replayed)).toHaveLength(1);
    expect(f.movements).toHaveLength(1);
    expect(f.stocks[0].released).toBe(2);
  });

  it('allows only one competing release for the same stock version', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.release(f.dto(), admin), f.service.release(f.dto(), operator)]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(f.movements).toHaveLength(1);
    expect(f.stocks[0]).toMatchObject({ onHand: 1, released: 2 });
  });

  it('validates all versions before creating the first movement', async () => {
    const f = fixture(); f.stocks[3].version = 1; const before = f.snapshot();
    const write = jest.spyOn(f.db.warehouseMovement, 'create');
    await expect(f.service.release(f.dto({ items: f.both() }), admin)).rejects.toThrow('changed');
    expect(write).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  });

  it('rolls back all stock and audit rows if a later write fails', async () => {
    const f = fixture(), before = f.snapshot(), create = f.db.warehouseMovement.create; let writes = 0;
    f.db.warehouseMovement.create = async (args) => { if (++writes === 2) throw new Error('Audit failure'); return create(args); };
    await expect(f.service.release(f.dto({ items: f.both() }), admin)).rejects.toThrow('Audit failure');
    expect(f.snapshot()).toEqual(before);
  });

  it.each([1, null])('never consumes another location when source %s has insufficient stock', async (storeId) => {
    const f = fixture(); f.balances[0].storeId = 2; const before = f.snapshot();
    await expect(f.service.release(f.dto({ storeId }), admin)).rejects.toThrow('source store');
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects a missing store but permits releasing existing stock from an inactive store like scan', async () => {
    const f = fixture();
    await expect(f.service.release(f.dto({ storeId: 999 }), admin)).rejects.toThrow('Store not found');
    f.stores[0].isActive = false;
    expect(await f.service.release(f.dto(), admin)).toMatchObject({ parts: 2 });
  });

  it('blocks releases during an open physical count', async () => {
    const f = fixture(); f.counts.push({ id: 15, activeSlot: 1 }); const before = f.snapshot();
    await expect(f.service.release(f.dto(), admin)).rejects.toThrow('Physical count');
    expect(f.snapshot()).toEqual(before);
  });

  it('preserves material payment restrictions for a mixed selection', async () => {
    const f = fixture(); f.external(); f.order.payment.status = 'PENDING'; const before = f.snapshot();
    await expect(f.service.release(f.dto({ items: f.both() }), admin)).rejects.toThrow('Material payment');
    expect(f.snapshot()).toEqual(before);
  });

  it('preserves installation and delivery payment restrictions', async () => {
    const f = fixture();
    f.order.estimate.installationJob = { status: 'SCHEDULED', quotes: [], payments: [] };
    await expect(f.service.release(f.dto(), admin)).rejects.toThrow('Installation payment');
    f.order.estimate.installationJob = null; f.order.fulfillmentMethod = 'COMPANY_DELIVERY';
    await expect(f.service.release(f.dto(), admin)).rejects.toThrow('Delivery payment');
    expect(f.movements).toHaveLength(0);
  });

  it('requires order readiness and fulfillment selection while supporting standalone external POs', async () => {
    const f = fixture(); f.order.status.name = 'Draft';
    await expect(f.service.release(f.dto(), admin)).rejects.toThrow('ready');
    f.order.status.name = 'Ready to pick up'; f.order.fulfillmentMethod = 'UNDECIDED';
    await expect(f.service.release(f.dto(), admin)).rejects.toThrow('Choose Pickup or Delivery');
    f.external();
    expect(await f.service.release(f.dto({ items: [{ barcode: fixed, quantity: 1, version: 0 }] }), admin)).toMatchObject({ parts: 1 });
  });

  it.each(['client', 'dealer', 'technician'] as const)('does not extend release access to %s', async (role) => {
    const f = fixture();
    await expect(f.service.release(f.dto(), { id: 3, role: { name: role } })).rejects.toThrow(ForbiddenException);
    expect(f.movements).toHaveLength(0);
  });

  it('inherits the admin/operator controller authorization without a role override', () => {
    expect(Reflect.getMetadata(ROLES_KEY, WarehouseController)).toEqual(['admin', 'operator']);
    expect(Reflect.getMetadata(ROLES_KEY, WarehouseController.prototype.release)).toBeUndefined();
  });

  it.each([
    { requestKey: '' }, { requestKey: 'not-a-uuid' }, { storeId: undefined }, { storeId: 0 }, { storeId: -1 }, { storeId: 1.5 }, { storeId: '1' },
    { items: [] }, { items: [null] }, { items: Array(501).fill({ barcode: door, quantity: 1, version: 0 }) },
    { items: [{ barcode: door, quantity: 0, version: 0 }] }, { items: [{ barcode: door, quantity: 201, version: 0 }] },
    { items: [{ barcode: door, quantity: 1.5, version: 0 }] }, { items: [{ barcode: door, quantity: 1, version: -1 }] },
    { items: [{ barcode: door, quantity: 1, version: 0.5 }] }, { items: [{ barcode: 'invalid', quantity: 1, version: 0 }] },
    { items: [{ barcode: undefined, quantity: 1, version: 0 }] }, { items: [{ barcode: 1029975, quantity: 1, version: 0 }] },
    { items: [{ barcode: door, quantity: 1, version: 0 }, { barcode: `I0${door}`, quantity: 1, version: 0 }] },
  ])('rejects malformed input before changing stock: %#', async (changes) => {
    const f = fixture(), before = f.snapshot();
    await expect(f.service.release(f.dto(changes as any), admin)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  });

  it('validates explicit nullable source and nested quantities at the HTTP boundary', async () => {
    const f = fixture();
    for (const storeId of [1, null])
      expect(await validate(plainToInstance(WarehouseReleaseDto, f.dto({ storeId })))).toHaveLength(0);
    for (const changes of [{ storeId: undefined }, { storeId: 0 }, { items: [{ barcode: door, quantity: -1, version: 0 }] }, { requestKey: '' }])
      expect(await validate(plainToInstance(WarehouseReleaseDto, f.dto(changes)))).not.toHaveLength(0);
  });
});

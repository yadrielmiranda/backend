import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

// Las salidas siguen cubiertas por la suite existente, sin modificar sus reglas.
jest.mock('./warehouse-release', () => ({ assertWarehouseRelease: jest.fn(async () => undefined) }));
const tech = { id: 3, role: { name: 'technician' as const } };
const admin = { id: 1, role: { name: 'admin' as const } };
const door = '1029975', fixed = '1096240';
const request = () => ({ requestKey: randomUUID() });
function fixture() {
  const f = warehouseFixture();
  return { ...f, service: new WarehouseService(f.db) };
}

describe('Technician receiving scope', () => {
  it('collects in transit without choosing a store and retains the existing audit', async () => {
    const f = fixture(); f.stores.splice(0);
    const saved = await f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech);
    expect(saved.stock).toMatchObject({ inTransit: 1, onHand: 0, pending: 2 });
    expect(f.movements[0]).toMatchObject({ actorId: 3, type: 'COLLECT' });
    expect(f.movements[0].createdAt).toBeInstanceOf(Date);
    expect(f.balances).toHaveLength(0);
  });
  it('lets the same technician collect and receive into a configured store', async () => {
    const f = fixture();
    await f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech);
    const saved = await f.service.technicianScan({ ...request(), barcode: door, action: 'RECEIVE', storeId: 2 }, tech);
    expect(saved.stock).toMatchObject({ inTransit: 0, onHand: 1 });
    expect(saved.movement.toStore?.id).toBe(2);
    expect(f.movements.map((m) => m.actorId)).toEqual([3, 3]);
    expect(f.balances[0]).toMatchObject({ storeId: 2, onHand: 1 });
  });
  it('keeps direct receipt available without a previous collection', async () => {
    const f = fixture();
    const saved = await f.service.technicianScan({ ...request(), barcode: fixed, action: 'RECEIVE', storeId: 1 }, tech);
    expect(saved.stock).toMatchObject({ onHand: 1, inTransit: 0 });
  });
  it('replays a lost scan response without adding another part or movement', async () => {
    const f = fixture(), dto = { ...request(), barcode: door, action: 'COLLECT' as const };
    const first = await f.service.technicianScan(dto, tech);
    const second = await f.service.technicianScan(dto, tech);
    expect(second.replayed).toBe(true); expect(second.movement.id).toBe(first.movement.id);
    expect(f.movements).toHaveLength(1); expect(f.stocks[0].inTransit).toBe(1);
  });
  it('receives a selected batch, supports splitting stores and keeps batch retries idempotent', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) await f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech);
    const dto = { ...request(), storeId: 1, items: [{ barcode: door, version: f.stocks[0].version, quantity: 2 }] };
    await f.service.receive(dto, tech);
    expect((await f.service.receive(dto, tech)).replayed).toBe(true);
    expect(f.stocks[0]).toMatchObject({ onHand: 2, inTransit: 1 });
    await f.service.receive({ ...request(), storeId: 2, items: [{ barcode: door, version: f.stocks[0].version, quantity: 1 }] }, tech);
    expect(f.stocks[0]).toMatchObject({ onHand: 3, inTransit: 0 });
    expect(f.balances.map((b) => [b.storeId, b.onHand])).toEqual([[1, 2], [2, 1]]);
  });
  it('rejects a stale batch atomically', async () => {
    const f = fixture();
    await f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech);
    await f.service.technicianScan({ ...request(), barcode: fixed, action: 'COLLECT' }, tech);
    const before = structuredClone(f.stocks), movements = f.movements.length;
    await expect(f.service.receive({ ...request(), storeId: 1, items: [
      { barcode: door, version: f.stocks[0].version, quantity: 1 },
      { barcode: fixed, version: 0, quantity: 1 },
    ] }, tech)).rejects.toThrow('changed');
    expect(f.stocks).toEqual(before); expect(f.movements).toHaveLength(movements);
  });
  it('preserves physical part limits', async () => {
    const f = fixture();
    await f.service.technicianScan({ ...request(), barcode: fixed, action: 'COLLECT' }, tech);
    await expect(f.service.technicianScan({ ...request(), barcode: fixed, action: 'COLLECT' }, tech)).rejects.toThrow();
    expect(f.stocks[3].inTransit).toBe(1); expect(f.movements).toHaveLength(1);
  });
  it('lists only in-transit units and does not return commercial or customer data', async () => {
    const f = fixture();
    await f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech);
    await f.service.technicianScan({ ...request(), barcode: fixed, action: 'RECEIVE', storeId: 1 }, tech);
    const list = await f.service.technicianPending({ view: 'all', storeId: '1' }, tech);
    expect(list.total).toBe(1); expect(list.items[0].barcode).toBe(`I${door}`);
    for (const key of ['customer', 'project', 'orderId', 'pieceId', 'price', 'rate', 'markup', 'stores', 'released'])
      expect(list.items[0]).not.toHaveProperty(key);
    expect(list).not.toHaveProperty('summary');
    expect(list.items[0].poNumber).toBe('281374');
  });
  it('shows active stores and indicates an open count without exposing its details', async () => {
    const f = fixture(); f.stores[1].isActive = false;
    expect((await f.service.technicianState(tech)).stores.map((s) => s.id)).toEqual([1]);
    await f.service.startCount({ ...request(), scope: 'ALL' }, admin);
    const state = await f.service.technicianState(tech);
    expect(state.countOpen).toBe(true); expect(state).not.toHaveProperty('activeCountId');
    await expect(f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech)).rejects.toThrow();
    expect(f.movements).toHaveLength(0);
  });
  it.each([undefined, null, 0, 99])('rejects an unavailable receipt destination (%s)', async (storeId) => {
    const f = fixture();
    await expect(f.service.technicianScan({ ...request(), barcode: door, action: 'RECEIVE', storeId }, tech)).rejects.toThrow();
    expect(f.movements).toHaveLength(0);
  });
  it('cannot release stock through the shared service or the technician service', async () => {
    const f = fixture();
    for (const method of ['scan', 'technicianScan'] as const)
      await expect(f.service[method]({ ...request(), barcode: door, action: 'RELEASE', storeId: 1 }, tech)).rejects.toThrow(ForbiddenException);
    expect(f.movements).toHaveLength(0);
  });
  it('cannot access inventory, movement history, transfers, adjustments, store management or counts', async () => {
    const f = fixture();
    const calls = [
      () => f.service.inventory({}, tech), () => f.service.history({}, tech),
      () => f.service.unit(door, tech), () => f.service.stores(tech),
      () => f.service.createStore({ name: 'Not allowed' }, tech),
      () => f.service.updateStore(1, { name: 'Not allowed', isActive: true, version: 0 }, tech),
      () => f.service.transfer({ ...request(), barcode: door, fromStoreId: null, toStoreId: 1, quantity: 1, version: 0 }, tech),
      () => f.service.undo(1, request(), tech),
      () => f.service.setParts(door, { ...request(), expectedParts: 5, version: 0, reason: 'Not allowed' }, tech),
      () => f.service.counts(tech), () => f.service.startCount({ ...request(), scope: 'ALL' }, tech),
      () => f.service.count(1, {}, tech), () => f.service.countScan(1, { ...request(), barcode: door }, tech),
      () => f.service.closeCount(1, { action: 'CANCEL' }, tech),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(ForbiddenException);
  });
  it.each(['dealer', 'client', 'operator', 'admin'])('requires a technician account at the dedicated %s access boundary', async (name) => {
    const f = fixture(), actor: any = { id: 1, role: { name } };
    await expect(f.service.technicianState(actor)).rejects.toThrow(ForbiddenException);
    await expect(f.service.technicianPending({}, actor)).rejects.toThrow(ForbiddenException);
    await expect(f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, actor)).rejects.toThrow(ForbiddenException);
  });
});

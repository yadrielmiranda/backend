import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

// Las salidas siguen cubiertas por la suite existente, sin modificar sus reglas.
jest.mock('./warehouse-release', () => ({ assertWarehouseRelease: jest.fn(async () => undefined) }));
const tech = { id: 3, role: { name: 'technician' as const } };
const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const door = '1029975', fixed = '1096240';
const request = () => ({ requestKey: randomUUID() });
function fixture() {
  const f = warehouseFixture();
  return { ...f, service: new WarehouseService(f.db) };
}
const startPickup = (f: ReturnType<typeof fixture>) =>
  f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);

describe('Technician receiving scope', () => {
  it('collects in transit without choosing a store and retains the existing audit', async () => {
    const f = fixture(); f.stores.splice(0);
    const pickup = await startPickup(f);
    const saved = await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
    expect(saved.kind).toBe('COLLECTED');
    if (saved.kind !== 'COLLECTED') throw new Error('Expected collected scan');
    expect(saved.stock).toMatchObject({ inTransit: 1, onHand: 0, pending: 2 });
    expect(f.movements[0]).toMatchObject({ actorId: 3, type: 'COLLECT' });
    expect(f.movements[0].createdAt).toBeInstanceOf(Date);
    expect(f.balances).toHaveLength(0);
  });
  it('lets the same technician collect and receive into a configured store', async () => {
    const f = fixture();
    const pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
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
    const f = fixture(), pickup = await startPickup(f), dto = { ...request(), barcode: door };
    const first = await f.service.factoryPickupScan(pickup.id, dto, tech);
    const second = await f.service.factoryPickupScan(pickup.id, dto, tech);
    expect(first.kind).toBe('COLLECTED'); expect(second.kind).toBe('COLLECTED');
    if (first.kind !== 'COLLECTED' || second.kind !== 'COLLECTED') throw new Error('Expected collected scan');
    expect(second.replayed).toBe(true); expect(second.movement.id).toBe(first.movement.id);
    expect(f.movements).toHaveLength(1); expect(f.stocks[0].inTransit).toBe(1);
  });
  it('receives a selected batch, supports splitting stores and keeps batch retries idempotent', async () => {
    const f = fixture(), pickup = await startPickup(f);
    for (let i = 0; i < 3; i++) await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
    const dto = { ...request(), storeId: 1, items: [{ barcode: door, version: f.stocks[0].version, quantity: 2 }] };
    await f.service.receive(dto, tech);
    expect((await f.service.receive(dto, tech)).replayed).toBe(true);
    expect(f.stocks[0]).toMatchObject({ onHand: 2, inTransit: 1 });
    await f.service.receive({ ...request(), storeId: 2, items: [{ barcode: door, version: f.stocks[0].version, quantity: 1 }] }, tech);
    expect(f.stocks[0]).toMatchObject({ onHand: 3, inTransit: 0 });
    expect(f.balances.map((b) => [b.storeId, b.onHand])).toEqual([[1, 2], [2, 1]]);
  });
  it('rejects a stale batch atomically', async () => {
    const f = fixture(), pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: fixed }, tech);
    const before = structuredClone(f.stocks), movements = f.movements.length;
    await expect(f.service.receive({ ...request(), storeId: 1, items: [
      { barcode: door, version: f.stocks[0].version, quantity: 1 },
      { barcode: fixed, version: 0, quantity: 1 },
    ] }, tech)).rejects.toThrow('changed');
    expect(f.stocks).toEqual(before); expect(f.movements).toHaveLength(movements);
  });
  it('preserves physical part limits', async () => {
    const f = fixture(), pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: fixed }, tech);
    await expect(f.service.factoryPickupScan(pickup.id, { ...request(), barcode: fixed }, tech)).rejects.toThrow();
    expect(f.stocks[3].inTransit).toBe(1); expect(f.movements).toHaveLength(1);
  });
  it('lists only in-transit units and does not return commercial or customer data', async () => {
    const f = fixture(), pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
    await f.service.technicianScan({ ...request(), barcode: fixed, action: 'RECEIVE', storeId: 1 }, tech);
    const list = await f.service.technicianPending({ view: 'all', storeId: '1' }, tech);
    expect(list.total).toBe(1); expect(list.items[0].barcode).toBe(`I${door}`);
    for (const key of ['customer', 'project', 'orderId', 'pieceId', 'price', 'rate', 'markup', 'stores', 'released'])
      expect(list.items[0]).not.toHaveProperty(key);
    expect(list).not.toHaveProperty('summary');
    expect(list.items[0].poNumber).toBe('281374');
  });
  it('requires a pickup run for technician factory collection', async () => {
    const f = fixture();
    await expect(
      f.service.technicianScan({ ...request(), barcode: door, action: 'COLLECT' }, tech),
    ).rejects.toThrow('factory pickup');
    expect(f.movements).toHaveLength(0);
  });
  it.each([['admin', admin]] as const)(
    'allows %s to use the same factory pickup run and keeps the actor audit',
    async (_role, actor) => {
      const f = fixture();
      const pickup = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, actor);
      const saved = await f.service.factoryPickupScan(
        pickup.id,
        { ...request(), barcode: door },
        actor,
      );
      expect(saved.kind).toBe('COLLECTED');
      expect(f.movements).toHaveLength(1);
      expect(f.movements[0]).toMatchObject({ actorId: actor.id, pickupRunId: pickup.id, type: 'COLLECT' });
      expect((await f.service.factoryPickupCurrent(actor))?.id).toBe(pickup.id);
    },
  );
  it.each(['technician', 'operator', 'dealer', 'client'])('does not allow a %s to start a factory pickup run', async (name) => {
    const f = fixture(), actor: any = { id: 20, role: { name } };
    await expect(
      f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, actor),
    ).rejects.toThrow(ForbiddenException);
    expect(f.movements).toHaveLength(0);
  });
  it('keeps warehouse undo compatible with an active admin pickup run', async () => {
    const f = fixture();
    const pickup = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    const saved = await f.service.factoryPickupScan(
      pickup.id,
      { ...request(), barcode: door },
      admin,
    );
    expect(saved.kind).toBe('COLLECTED');
    if (saved.kind !== 'COLLECTED') throw new Error('Expected collected scan');
    await f.service.undo(saved.movement.id, request(), admin);
    const current = await f.service.factoryPickupCurrent(admin);
    expect(current?.collectedParts).toBe(0);
    expect(current?.lines.find((line) => line.lineNumber === door)).toMatchObject({
      collected: 0,
      remaining: 3,
    });
    expect(f.stocks[0].inTransit).toBe(0);
    expect(f.movements).toHaveLength(2);
    for (let i = 0; i < 3; i++)
      await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, admin);
    const rescanned = await f.service.factoryPickupCurrent(admin);
    expect(rescanned?.lines.find(line => line.lineNumber === door)).toMatchObject({ collected: 3, remaining: 0 });
    expect(f.stocks[0].inTransit).toBe(3);
  });
  it('keeps an active pickup target stable and permits corrections after closing it', async () => {
    const f = fixture(), pickup = await startPickup(f);
    const dto = { ...request(), expectedParts: 2, version: 0, reason: 'Correct factory parts' };
    await expect(f.service.setParts(fixed, dto, admin)).rejects.toThrow('Finish the active factory pickup');
    expect(f.stocks[3].expectedParts).toBe(1);
    expect(f.movements).toHaveLength(0);
    await f.service.finishFactoryPickup(pickup.id, { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' }, tech);
    await f.service.setParts(fixed, dto, admin);
    const next = await startPickup(f);
    expect(next.lines.find(line => line.lineNumber === fixed)?.targetParts).toBe(2);
    expect(f.pickupRunLines.find(line => line.pickupRunId === pickup.id && line.lineNumber === fixed)?.targetParts).toBe(1);
  });
  it('offers to add a known PO discovered during scanning and records the same scan after confirmation', async () => {
    const f = fixture();
    const secondOrder = { ...f.order, id: 2, number: '1002', poNumber: '293600' };
    f.orders.push(secondOrder);
    f.pieces[3].estim.order = secondOrder;
    const pickup = await startPickup(f), key = randomUUID();
    const first = await f.service.factoryPickupScan(
      pickup.id,
      { requestKey: key, barcode: fixed },
      tech,
    );
    expect(first).toMatchObject({
      kind: 'PO_NOT_INCLUDED',
      candidate: { poNumber: '293600', lineNumber: fixed, parts: 1 },
    });
    expect(f.movements).toHaveLength(0);
    const added = await f.service.factoryPickupScan(
      pickup.id,
      { requestKey: key, barcode: fixed, addPo: true },
      tech,
    );
    expect(added.kind).toBe('COLLECTED');
    if (added.kind !== 'COLLECTED') throw new Error('Expected collected scan');
    expect(added.pickup.poCount).toBe(2);
    expect(added.pickup.orders.find((item) => item.poNumber === '293600')).toMatchObject({
      addedDuringPickup: true,
      collectedParts: 1,
      remainingParts: 0,
    });
    expect(f.movements).toHaveLength(1);
    expect(f.movements[0]).toMatchObject({ pickupRunId: pickup.id, lineNumber: fixed });
  });
  it('finishes a partial pickup explicitly and carries only the remaining factory parts into a later run', async () => {
    const f = fixture(), pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech);
    await expect(f.service.finishFactoryPickup(pickup.id, { cycle: 0 }, tech)).rejects.toThrow('Choose why');
    const closed = await f.service.finishFactoryPickup(
      pickup.id,
      { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY', note: 'Remaining parts were not ready.' },
      tech,
    );
    expect(closed).toMatchObject({ status: 'PARTIAL', collectedParts: 1, remainingParts: 8 });
    expect(await f.service.factoryPickupCurrent(tech)).toBeNull();
    const next = await startPickup(f);
    expect(next.expectedParts).toBe(8);
    expect(next.lines.find((line) => line.lineNumber === door)).toMatchObject({ targetParts: 2, collected: 0 });
  });
  it('shows active stores and indicates an open count without exposing its details', async () => {
    const f = fixture(); f.stores[1].isActive = false;
    expect((await f.service.technicianState(tech)).stores.map((s) => s.id)).toEqual([1]);
    const pickup = await startPickup(f);
    await f.service.startCount({ ...request(), scope: 'ALL' }, admin);
    const state = await f.service.technicianState(tech);
    expect(state.countOpen).toBe(true); expect(state).not.toHaveProperty('activeCountId');
    await expect(f.service.factoryPickupScan(pickup.id, { ...request(), barcode: door }, tech)).rejects.toThrow();
    expect(f.movements).toHaveLength(0);
  });
  it('replays a completed finish without changing its timestamp or writing duplicate movements', async () => {
    const f = fixture(); f.stocks.splice(0, 3);
    const pickup = await startPickup(f);
    await f.service.factoryPickupScan(pickup.id, { ...request(), barcode: fixed }, tech);
    const closed = await f.service.finishFactoryPickup(pickup.id, { cycle: 0, note: 'All loaded' }, tech);
    const again = await f.service.finishFactoryPickup(pickup.id, { cycle: 0, note: ' All loaded ' }, tech);
    expect(again).toEqual(closed);
    expect(again.status).toBe('COMPLETED');
    expect(f.movements).toHaveLength(1);
    await expect(f.service.finishFactoryPickup(pickup.id, { cycle: 0, note: 'Different' }, tech)).rejects.toThrow('different details');
    expect(await f.service.finishFactoryPickup(pickup.id, { cycle: 0, note: 'All loaded' }, admin)).toEqual(closed);
  });
  it('replays a partial finish after a new pickup starts without freeing its PO', async () => {
    const f = fixture(), pickup = await startPickup(f);
    const dto = { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' as const, note: 'Return tomorrow' };
    const [first, retry] = await Promise.all([
      f.service.finishFactoryPickup(pickup.id, dto, tech),
      f.service.finishFactoryPickup(pickup.id, dto, tech),
    ]);
    expect(retry).toEqual(first);
    const next = await startPickup(f);
    expect(await f.service.finishFactoryPickup(pickup.id, dto, tech)).toEqual(first);
    expect((await f.service.factoryPickupCurrent(tech))?.id).toBe(next.id);
    expect(f.pickupRunOrders.find(row => row.pickupRunId === next.id)?.activeSlot).toBe(1);
    await expect(f.service.finishFactoryPickup(pickup.id, { cycle: 0, partialReason: 'OTHER', note: dto.note }, tech)).rejects.toThrow('different details');
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

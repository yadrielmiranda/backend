import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const otherAdmin = { id: 5, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const second = { id: 4, role: { name: 'technician' as const } };
const unassigned = { id: 6, role: { name: 'technician' as const } };
const door = '1029975', slider = '1029967', fixed = '1096240';
const scan = (barcode = door) => ({ barcode, requestKey: randomUUID() });
const partial = { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' as const, note: 'Return later' };
function fixture() {
  const f = warehouseFixture();
  const service = new WarehouseService(f.db);
  return { ...f, service, start: (ids = [3, 4], poNumbers = ['281374']) => service.startFactoryPickup({ poNumbers, technicianIds: ids }, admin) };
}
function secondPo(f: ReturnType<typeof fixture>, index = 1) {
  const order = { ...f.order, id: 2, number: '1002', poNumber: '293600' };
  f.orders.push(order); f.pieces[index].estim.order = order;
  return order;
}

describe('Shared factory pickups and admin reopening', () => {
  it('shows all pickups to every admin and only assigned pickups to technicians', async () => {
    const f = fixture(); secondPo(f);
    const a = await f.start([3]), b = await f.start([4], ['293600']);
    for (const actor of [admin, otherAdmin]) assert.equal((await f.service.factoryPickups({}, actor)).total, 2);
    assert.deepEqual((await f.service.factoryPickups({}, tech)).items.map((r) => r.id), [a.id]);
    assert.deepEqual((await f.service.factoryPickups({}, second)).items.map((r) => r.id), [b.id]);
    assert.equal((await f.service.factoryPickups({}, unassigned)).total, 0);
    assert.equal(await f.service.factoryPickupCurrent(unassigned), null);
    assert.equal((await f.service.technicianState(tech)).activePickupCount, 1);
    assert.equal((await f.service.factoryPickup(a.id, otherAdmin)).createdBy.id, admin.id);
  });

  it('denies direct access, scanning and closure to an unassigned technician', async () => {
    const f = fixture(), run = await f.start();
    for (const action of [() => f.service.factoryPickup(run.id, unassigned),
      () => f.service.factoryPickupScan(run.id, scan(), unassigned),
      () => f.service.finishFactoryPickup(run.id, partial, unassigned)]) await assert.rejects(action, /not found/);
    assert.equal(f.movements.length, 0); assert.equal(f.pickupRuns[0].status, 'ACTIVE');
  });

  it('allows only admins to create, assign and reopen pickups', async () => {
    const f = fixture(), run = await f.start();
    for (const role of ['technician', 'operator', 'dealer', 'client'] as const) {
      const actor = { id: 3, role: { name: role } };
      await assert.rejects(() => f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, actor));
      await assert.rejects(() => f.service.assignFactoryPickup(run.id, { technicianIds: [3] }, actor));
      await assert.rejects(() => f.service.reopenFactoryPickup(run.id, { cycle: 0 }, actor));
    }
    assert.equal(f.pickupRuns.length, 1);
  });

  it('requires valid active technician accounts and validates PO numbers atomically', async () => {
    const f = fixture();
    f.users.find((u) => u.id === 6)!.isActive = false;
    f.users.find((u) => u.id === 4)!.deletedAt = new Date() as any;
    for (const ids of [[], [3, 3], [1], [2], [6], [4], [999], [0], [1.5]]) await assert.rejects(() => f.start(ids));
    await assert.rejects(() => f.start([3], ['DOES-NOT-EXIST']), /PO not found/);
    await assert.rejects(() => f.start([3], ['281374', 'MISTYPED']), /PO not found/);
    await assert.rejects(() => f.start([3], ['281374', '281374']), /only once/);
    assert.equal(f.pickupRuns.length, 0); assert.equal(f.pickupRunTechnicians.length, 0);
    assert.deepEqual((await f.service.factoryPickupTechnicians(admin)).map((u) => u.id), [3]);
  });

  it('shares multiple technician scans, caps quantities and keeps the individual audit', async () => {
    const f = fixture(), run = await f.start();
    const results = await Promise.allSettled([tech, second, otherAdmin, tech].map((actor) => f.service.factoryPickupScan(run.id, scan(), actor)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(f.stocks[0].inTransit, 3); assert.equal(f.movements.length, 3);
    const current = await f.service.factoryPickup(run.id, tech);
    assert.equal(current.collectedParts, 3);
    assert.deepEqual(current.collectors.map((c) => [c.id, c.parts]), [[3, 1], [4, 1], [5, 1]]);
    assert(current.collectors.every((c) => c.firstScanAt instanceof Date && c.lastScanAt instanceof Date));
  });

  it('records the same request only once during concurrent retries', async () => {
    const f = fixture(), run = await f.start(), dto = scan();
    const results = await Promise.all([f.service.factoryPickupScan(run.id, dto, tech), f.service.factoryPickupScan(run.id, dto, tech)]);
    assert(results.every((r) => r.kind === 'COLLECTED'));
    assert.equal(f.movements.length, 1); assert.equal(f.stocks[0].inTransit, 1);
    await assert.rejects(() => f.service.factoryPickupScan(run.id, dto, second), /identifier/);
  });

  it('allows concurrent discovery of the same unplanned PO without duplicating it', async () => {
    const f = fixture(); secondPo(f);
    const run = await f.start(), a = scan(slider), b = scan(slider);
    for (const [actor, dto] of [[tech, a], [second, b]] as const)
      assert.equal((await f.service.factoryPickupScan(run.id, dto, actor)).kind, 'PO_NOT_INCLUDED');
    assert.equal(f.movements.length, 0);
    await Promise.all([f.service.factoryPickupScan(run.id, { ...a, addPo: true }, tech), f.service.factoryPickupScan(run.id, { ...b, addPo: true }, second)]);
    const current = await f.service.factoryPickup(run.id, tech);
    assert.equal(current.poCount, 2); assert.equal(current.collectedParts, 2);
    assert.equal(f.pickupRunOrders.filter((r) => r.orderId === 2).length, 1);
    assert.equal(f.pickupRunLines.filter((r) => r.lineNumber === slider).length, 1);
    assert(current.orders.find((o) => o.orderId === 2)!.addedDuringPickup);
  });

  it('keeps a PO exclusive to one active pickup and rejects collection outside that pickup', async () => {
    const f = fixture(); secondPo(f);
    const a = await f.start(), b = await f.start([3, 4], ['293600']);
    await assert.rejects(() => f.start(), /another active/);
    await assert.rejects(() => f.service.factoryPickupScan(a.id, { ...scan(slider), addPo: true }, tech), /another active/);
    await assert.rejects(() => f.service.scan({ ...scan(), action: 'COLLECT' }, admin), /assigned factory pickup/);
    assert.equal(f.movements.length, 0); assert.equal((await f.service.factoryPickup(b.id, tech)).collectedParts, 0);
  });

  it('lets a second technician close the pickup for everyone and replay an earlier scan', async () => {
    const f = fixture(), run = await f.start(), dto = scan();
    await f.service.factoryPickupScan(run.id, dto, tech);
    await assert.rejects(() => f.service.finishFactoryPickup(run.id, { cycle: 0 }, second), /Choose why/);
    const closed = await f.service.finishFactoryPickup(run.id, partial, second);
    assert.equal(closed.closedBy!.id, 4); assert.equal(closed.status, 'PARTIAL');
    assert.equal((await f.service.factoryPickups({}, tech)).total, 0);
    assert.equal((await f.service.factoryPickups({ status: 'CLOSED' }, tech)).total, 1);
    await assert.rejects(() => f.service.factoryPickupScan(run.id, scan(), tech), /already closed/);
    const replay = await f.service.factoryPickupScan(run.id, dto, tech);
    assert.equal(replay.kind, 'COLLECTED'); if (replay.kind !== 'COLLECTED') throw new Error();
    assert(replay.replayed); assert.equal(replay.pickup.status, 'PARTIAL'); assert.equal(f.movements.length, 1);
    assert.deepEqual(await f.service.finishFactoryPickup(run.id, partial, otherAdmin), closed);
    assert.equal(f.pickupRunEvents.length, 1);
  });

  it('serializes a last scan and closure, leaving one complete, consistent result', async () => {
    const f = fixture(); f.stocks.splice(0, 3);
    const run = await f.start();
    const [, closed] = await Promise.all([
      f.service.factoryPickupScan(run.id, scan(fixed), tech),
      f.service.finishFactoryPickup(run.id, { cycle: 0 }, second),
    ]);
    assert.equal(closed.status, 'COMPLETED'); assert.equal(closed.collectedParts, 1);
    await assert.rejects(() => f.service.factoryPickupScan(run.id, scan(fixed), tech), /already closed/);
  });

  it('rejects a scan queued after closure without changing physical stock', async () => {
    const f = fixture(), run = await f.start();
    const results = await Promise.allSettled([
      f.service.finishFactoryPickup(run.id, partial, second), f.service.factoryPickupScan(run.id, scan(), tech),
    ]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(f.movements.length, 0);
  });

  it('reopens for all assigned technicians, preserves history and rejects an old close retry', async () => {
    const f = fixture(), run = await f.start();
    await f.service.factoryPickupScan(run.id, scan(), tech);
    await f.service.finishFactoryPickup(run.id, partial, second);
    const reopened = await f.service.reopenFactoryPickup(run.id, { cycle: 0 }, otherAdmin);
    assert.equal(reopened.status, 'ACTIVE'); assert.equal(reopened.cycle, 1);
    assert.equal(reopened.collectedParts, 1); assert.equal(reopened.closedBy, null);
    assert.deepEqual(reopened.events.map((e) => [e.status, e.actor.id]), [['PARTIAL', 4], ['ACTIVE', 5]]);
    assert.deepEqual(await f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin), reopened);
    await assert.rejects(() => f.service.finishFactoryPickup(run.id, partial, second), /reopened/);
    await f.service.factoryPickupScan(run.id, scan(), second);
    const closed = await f.service.finishFactoryPickup(run.id, { ...partial, cycle: 1 }, admin);
    assert.equal(closed.collectedParts, 2); assert.equal(closed.events.length, 3);
    assert.equal(closed.events[0].note, partial.note);
    await assert.rejects(() => f.service.reopenFactoryPickup(run.id, { cycle: 0 }, otherAdmin), /changed/);
    assert.equal(f.pickupRuns[0].status, 'PARTIAL');
  });

  it('blocks reopening when a PO is already active elsewhere, without releasing its reservation', async () => {
    const f = fixture(), first = await f.start();
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start();
    await assert.rejects(() => f.service.reopenFactoryPickup(first.id, { cycle: 0 }, admin), /already in active pickup/);
    assert.equal(f.pickupRunOrders.find((r) => r.pickupRunId === next.id)!.activeSlot, 1);
    assert.equal((await f.service.factoryPickup(first.id, admin)).status, 'PARTIAL');
  });

  it('blocks reopening an obsolete target already collected by a later pickup', async () => {
    const f = fixture(), first = await f.start();
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start();
    await f.service.factoryPickupScan(next.id, scan(), tech);
    await f.service.finishFactoryPickup(next.id, partial, second);
    await assert.rejects(() => f.service.reopenFactoryPickup(first.id, { cycle: 0 }, admin), /outside this pickup/);
    assert.equal(f.pickupRunEvents.length, 2);
  });

  it('can reopen a complete pickup, undo a mistaken scan and collect it again', async () => {
    const f = fixture(); f.stocks.splice(0, 3);
    const run = await f.start(), saved = await f.service.factoryPickupScan(run.id, scan(fixed), tech);
    if (saved.kind !== 'COLLECTED') throw new Error();
    await f.service.finishFactoryPickup(run.id, { cycle: 0 }, second);
    await assert.rejects(() => f.service.undo(saved.movement.id, { requestKey: randomUUID() }, admin), /already closed/);
    await f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin);
    await f.service.undo(saved.movement.id, { requestKey: randomUUID() }, admin);
    assert.equal((await f.service.factoryPickup(run.id, tech)).collectedParts, 0);
    await f.service.factoryPickupScan(run.id, scan(fixed), second);
    const closed = await f.service.finishFactoryPickup(run.id, { cycle: 1 }, tech);
    assert.equal(closed.status, 'COMPLETED'); assert.equal(closed.collectedParts, 1);
  });

  it('updates assignments immediately without losing the audit of earlier collectors', async () => {
    const f = fixture(), run = await f.start();
    await f.service.factoryPickupScan(run.id, scan(), tech);
    await f.service.assignFactoryPickup(run.id, { technicianIds: [4, 6] }, otherAdmin);
    await assert.rejects(() => f.service.factoryPickupScan(run.id, scan(), tech), /not found/);
    assert.equal((await f.service.factoryPickups({}, tech)).total, 0);
    assert.equal((await f.service.factoryPickups({}, unassigned)).total, 1);
    assert.equal((await f.service.factoryPickup(run.id, second)).collectors[0].id, 3);
    await f.service.finishFactoryPickup(run.id, partial, unassigned);
    await assert.rejects(() => f.service.assignFactoryPickup(run.id, { technicianIds: [3] }, admin), /already closed/);
  });

  it('collects unpaid material independently of order status and respects physical count blocking', async () => {
    const f = fixture(); f.order.payment.status = 'PENDING'; f.order.status.name = 'Awaiting release';
    const run = await f.start();
    await f.service.factoryPickupScan(run.id, scan(), tech);
    assert.equal(f.order.status.name, 'Awaiting release'); assert.equal(f.order.payment.status, 'PENDING');
    await f.service.finishFactoryPickup(run.id, partial, second);
    await f.service.startCount({ requestKey: randomUUID() }, admin);
    await assert.rejects(() => f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin));
    assert.equal(f.pickupRuns[0].status, 'PARTIAL'); assert.equal(f.stocks[0].inTransit, 1);
  });
});

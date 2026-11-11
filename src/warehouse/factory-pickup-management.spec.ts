import assert = require('node:assert/strict');
import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const partial = { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' as const };
const scan = () => ({ barcode: '1029975-DOOR', requestKey: randomUUID() });
function fixture() {
  const f = warehouseFixture();
  const service = new WarehouseService(f.db);
  return { ...f, service, start: (poNumbers = ['281374']) =>
    service.startFactoryPickup({ poNumbers, technicianIds: [3] }, admin) };
}
function secondPo(f: ReturnType<typeof fixture>) {
  const order = { ...f.order, id: 2, number: '1002', poNumber: '293600' };
  f.orders.push(order);
  f.pieces[1].estim.order = order;
  return order;
}
function externalPo(f: ReturnType<typeof fixture>) {
  f.externalPos.push({ id: 1, orderId: null, poNumber: 'EXTERNAL-1', customerName: 'Outside project' });
  f.stocks.push({ ...f.stocks[3], pieceId: null, externalPoId: 1, lineNumber: '9000001', description: 'Fixed Window' });
}

describe('Factory pickup PO management before the first movement', () => {
  it('adds internal and external POs atomically and keeps repeated additions idempotent', async () => {
    const f = fixture(); secondPo(f); externalPo(f);
    const stockBefore = structuredClone(f.stocks), run = await f.start();
    assert.equal(run.canEditOrders, true); assert.equal(run.canDelete, true);
    const updated = await f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600', 'EXTERNAL-1'] }, admin);
    assert.equal(updated.poCount, 3); assert.equal(updated.expectedParts, 10);
    expect(updated.orders.map(o => o.key)).toEqual(['order:1', 'order:2', 'external:1']);
    assert(updated.orders.slice(1).every(o => o.addedDuringPickup));
    await f.service.addFactoryPickupPos(run.id, { poNumbers: ['281374', '293600', 'EXTERNAL-1'] }, admin);
    assert.equal(f.pickupRunOrders.length, 3); assert.equal(f.pickupRunLines.length, 5);
    expect(f.stocks).toEqual(stockBefore); assert.equal(f.movements.length, 0);
  });

  it('removes only the exact source key, frees its PO reservation and leaves stock untouched', async () => {
    const f = fixture(); externalPo(f);
    const stockBefore = structuredClone(f.stocks), run = await f.start(['281374', 'EXTERNAL-1']);
    const updated = await f.service.removeFactoryPickupPo(run.id, 'external:1', admin);
    assert.equal(updated.poCount, 1); assert.equal(updated.orders[0].key, 'order:1');
    assert.equal(f.pickupRunLines.length, 4); assert(f.pickupRunLines.every(line => line.lineNumber !== '9000001'));
    await f.service.removeFactoryPickupPo(run.id, 'external:1', admin);
    const another = await f.start(['EXTERNAL-1']);
    assert.equal(another.poCount, 1); assert.equal(another.orders[0].key, 'external:1');
    expect(f.stocks).toEqual(stockBefore); assert.equal(f.movements.length, 0);
  });

  it('removes internal PO lines without deleting external lines with the same numeric ID', async () => {
    const f = fixture(); externalPo(f);
    const run = await f.start(['281374', 'EXTERNAL-1']);
    const updated = await f.service.removeFactoryPickupPo(run.id, 'order:1', admin);
    assert.equal(updated.poCount, 1); assert.equal(updated.orders[0].key, 'external:1');
    assert.deepEqual(f.pickupRunLines.map(line => line.lineNumber), ['9000001']);
    assert.equal((await f.start()).orders[0].key, 'order:1');
  });

  it('requires deleting the pickup instead of removing its last PO', async () => {
    const f = fixture(), run = await f.start();
    await assert.rejects(() => f.service.removeFactoryPickupPo(run.id, 'order:1', admin), /at least one PO/);
    assert.equal(f.pickupRunOrders.length, 1); assert.equal(f.pickupRunLines.length, 4);
    await assert.rejects(() => f.service.removeFactoryPickupPo(run.id, 'order:0', admin), /valid warehouse PO key/);
  });

  it('deletes unused pickups and their snapshots and assignments, releasing the POs', async () => {
    const f = fixture(); externalPo(f);
    const stockBefore = structuredClone(f.stocks), run = await f.start(['281374', 'EXTERNAL-1']);
    assert.deepEqual(await f.service.deleteFactoryPickup(run.id, admin), { id: run.id, deleted: true });
    for (const rows of [f.pickupRuns, f.pickupRunOrders, f.pickupRunLines, f.pickupRunTechnicians, f.pickupRunEvents])
      assert.equal(rows.length, 0);
    assert.deepEqual(await f.service.deleteFactoryPickup(run.id, admin), { id: run.id, deleted: true });
    expect(f.stocks).toEqual(stockBefore); assert.equal(f.movements.length, 0);
    assert.equal((await f.start(['281374', 'EXTERNAL-1'])).poCount, 2);
  });

  it('allows deleting a closed unused pickup but blocks editing its POs', async () => {
    const f = fixture(); secondPo(f);
    const run = await f.start(), closed = await f.service.finishFactoryPickup(run.id, partial, tech);
    assert.equal(closed.canEditOrders, false); assert.equal(closed.canDelete, false);
    const adminView = await f.service.factoryPickup(run.id, admin);
    assert.equal(adminView.canEditOrders, false); assert.equal(adminView.canDelete, true);
    await assert.rejects(() => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600'] }, admin), /already closed/);
    await assert.rejects(() => f.service.removeFactoryPickupPo(run.id, 'order:1', admin), /already closed/);
    assert.equal(f.pickupRunEvents.length, 1);
    await f.service.deleteFactoryPickup(run.id, admin);
    assert.equal(f.pickupRunEvents.length, 0); assert.equal(f.pickupRuns.length, 0);
  });

  it('keeps scanned pickups protected even after every scan is undone', async () => {
    const f = fixture(); secondPo(f);
    const run = await f.start(), saved = await f.service.factoryPickupScan(run.id, scan(), tech);
    if (saved.kind !== 'COLLECTED') throw new Error('Expected a collected part');
    await f.service.undo(saved.movement.id, { requestKey: randomUUID() }, admin);
    const current = await f.service.factoryPickup(run.id, admin);
    assert.equal(current.collectedParts, 0); assert.equal(current.canEditOrders, false); assert.equal(current.canDelete, false);
    for (const action of [
      () => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600'] }, admin),
      () => f.service.removeFactoryPickupPo(run.id, 'order:1', admin),
      () => f.service.deleteFactoryPickup(run.id, admin),
    ]) await assert.rejects(action, /recorded movements/);
    assert.equal(f.pickupRuns.length, 1); assert.equal(f.movements.length, 2); assert.equal(f.stocks[0].inTransit, 0);
  });

  it('restricts management and capability flags to admins, including assigned technicians', async () => {
    const f = fixture(); secondPo(f);
    const run = await f.start(), techView = await f.service.factoryPickup(run.id, tech);
    assert.equal(techView.canEditOrders, false); assert.equal(techView.canDelete, false);
    for (const role of ['technician', 'operator', 'dealer', 'client'] as const) {
      const actor = { id: 3, role: { name: role } };
      for (const action of [
        () => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600'] }, actor),
        () => f.service.removeFactoryPickupPo(run.id, 'order:1', actor),
        () => f.service.deleteFactoryPickup(run.id, actor),
      ]) await assert.rejects(action);
    }
    assert.equal(f.pickupRunOrders.length, 1); assert.equal(f.pickupRuns.length, 1);
  });

  it('rolls back all additions if any PO is invalid or reserved by another pickup', async () => {
    const f = fixture(); secondPo(f); externalPo(f);
    const run = await f.start();
    await assert.rejects(() => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600', 'NOT-FOUND'] }, admin), /PO not found/);
    assert.equal(f.pickupRunOrders.length, 1); assert.equal(f.pickupRunLines.length, 3);
    const other = await f.start(['EXTERNAL-1']);
    await assert.rejects(() => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600', 'EXTERNAL-1'] }, admin), /another active/);
    assert.equal(f.pickupRunOrders.length, 2);
    assert.equal((await f.service.factoryPickup(run.id, admin)).poCount, 1);
    assert.equal((await f.service.factoryPickup(other.id, admin)).poCount, 1);
    await assert.rejects(() => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600', '293600'] }, admin), /only once/);
    await assert.rejects(() => f.service.addFactoryPickupPos(run.id, { poNumbers: [] }, admin), /between 1 and 50/);
  });

  it('serializes scan and deletion so a pickup with a new movement cannot disappear', async () => {
    const f = fixture(), run = await f.start();
    const results = await Promise.allSettled([
      f.service.factoryPickupScan(run.id, scan(), tech), f.service.deleteFactoryPickup(run.id, admin),
    ]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(f.pickupRuns.length, 1); assert.equal(f.movements.length, 1); assert.equal(f.stocks[0].inTransit, 1);
  });

  it('rejects a scan queued after deletion without changing physical stock', async () => {
    const f = fixture(), run = await f.start();
    const results = await Promise.allSettled([
      f.service.deleteFactoryPickup(run.id, admin), f.service.factoryPickupScan(run.id, scan(), tech),
    ]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(f.pickupRuns.length, 0); assert.equal(f.movements.length, 0); assert.equal(f.stocks[0].inTransit, 0);
  });

  it('keeps the existing physical-count guard for changes and deletion', async () => {
    const f = fixture(); secondPo(f);
    const run = await f.start();
    await f.service.startCount({ requestKey: randomUUID() }, admin);
    for (const action of [
      () => f.service.addFactoryPickupPos(run.id, { poNumbers: ['293600'] }, admin),
      () => f.service.removeFactoryPickupPo(run.id, 'order:1', admin),
      () => f.service.deleteFactoryPickup(run.id, admin),
    ]) await assert.rejects(action, /Physical count/);
    assert.equal(f.pickupRuns.length, 1); assert.equal(f.pickupRunOrders.length, 1);
  });
});

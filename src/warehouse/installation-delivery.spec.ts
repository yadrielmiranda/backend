import { strict as assert } from 'node:assert';
import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

// El servicio conserva la política de salida real; solo se aísla el cálculo del plan.
jest.mock('@/payment-plans/payment-schedule', () => ({
  assertScheduleMilestone: jest.fn(async (db: { releaseCovered?: boolean; installationCovered?: boolean }, _id: number, milestone: string) => {
    if (db.releaseCovered === false) throw new Error('Release installment is unpaid.');
    if (milestone === 'INSTALL' && db.installationCovered === false) throw new Error('Installation installment is unpaid.');
    return { canRelease: true };
  }),
}));

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const door = '1029975', fixed = '1096240';
const address = '123 Test Street, Miami, FL 33101';
const request = () => ({ requestKey: randomUUID() });

function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  const job = { id: 71, status: 'SCHEDULED', installationAddress: {
    street: '123 Test Street', city: 'Miami', state: 'FL', postalCode: '33101',
  }, quotes: [], payments: [] };
  f.order.fulfillmentMethod = 'INSTALLATION_DELIVERY';
  f.order.status.name = 'Preparing for pickup';
  f.order.estimate.installationJob = job;
  f.db.releaseCovered = true;
  let pickupId: number | undefined;
  const stock = (barcode = door) => f.stocks.find((s) => s.lineNumber === barcode)!;
  const item = (barcode = door, quantity = 1) => ({ barcode, quantity, version: stock(barcode).version });
  const dto = (items = [item()]) => ({ ...request(), installationJobId: job.id, installationAddress: address, items });
  const collect = async (quantity = 1, barcode = door) => {
    pickupId ??= (await service.startFactoryPickup({ poNumbers: ['281374'] }, tech)).id;
    for (let i = 0; i < quantity; i++) await service.factoryPickupScan(pickupId, { ...request(), barcode }, tech);
  };
  const snapshot = () => structuredClone({ stocks: f.stocks, movements: f.movements, balances: f.balances });
  const invariant = () => {
    for (const s of f.stocks) {
      assert(s.inTransit >= 0 && s.onHand >= 0 && s.released >= 0);
      assert(s.inTransit + s.onHand + s.released <= s.expectedParts);
      assert.equal(s.onHand, s.unassigned + f.balances.filter((b) => b.lineNumber === s.lineNumber).reduce((sum, b) => sum + b.onHand, 0));
    }
  };
  return { ...f, service, job, stock, item, dto, collect, snapshot, invariant };
}

describe('physical delivery to installation', () => {
  it('delivers partial factory collections without creating warehouse stock', async () => {
    const f = fixture(); f.stores.splice(0);
    await f.collect(3);
    const result = await f.service.deliverToInstallation(f.dto([f.item(door, 2)]), tech);
    assert.equal(result.parts, 2); assert.equal(result.units, 1);
    assert.deepEqual(result.installation, { id: 71, address });
    assert.equal(f.stock().inTransit, 1); assert.equal(f.stock().onHand, 0); assert.equal(f.stock().released, 2);
    assert.equal(f.balances.length, 0);
    assert.equal((await f.service.factoryPickupCurrent(tech))!.collectedParts, 3);
    assert.equal(f.order.status.name, 'Preparing for pickup'); assert.equal(f.job.status, 'SCHEDULED');
    f.invariant();
  });

  it('clears delivered parts from Pending receipt and records actor, destination and quantities', async () => {
    const f = fixture(); await f.collect(3); await f.collect(1, fixed);
    await f.service.deliverToInstallation(f.dto([f.item(door, 3), f.item(fixed)]), operator);
    assert.equal((await f.service.inventory({ view: 'in_transit' }, admin)).total, 0);
    const delivered = f.movements.filter((m) => m.type === 'INSTALLATION_DELIVERY');
    assert.equal(delivered.length, 2);
    assert.equal(delivered.reduce((sum, m) => sum + m.quantity, 0), 4);
    for (const m of delivered) {
      assert.equal(m.installationJobId, 71); assert.equal(m.installationAddress, address);
      assert.equal(m.actorId, 2); assert(m.createdAt instanceof Date);
      assert.equal(m.onHandDelta, 0); assert.equal(m.fromStoreId, null); assert.equal(m.toStoreId, null);
    }
    f.invariant();
  });

  it('combines direct delivery and warehouse release without deducting the same quantity twice', async () => {
    const f = fixture(); await f.collect(3);
    await f.service.receive({ ...request(), storeId: 2, items: [f.item(door, 2)] }, tech);
    const released = await f.service.scan({ ...request(), action: 'RELEASE', barcode: door, storeId: 2 }, admin);
    assert.deepEqual(released.movement.installation, { id: 71, address });
    await f.service.deliverToInstallation(f.dto(), tech);
    assert.equal(f.stock().inTransit, 0); assert.equal(f.stock().onHand, 1); assert.equal(f.stock().released, 2);
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /in transit/);
    assert.deepEqual(f.snapshot(), before);
    await f.service.scan({ ...request(), action: 'RELEASE', barcode: door, storeId: 2 }, operator);
    assert.equal(f.stock().onHand, 0); assert.equal(f.stock().released, 3);
    assert.equal(f.balances[0].onHand, 0); f.invariant();
  });

  it('keeps internal collection and receipt available while release is unpaid', async () => {
    const f = fixture(); f.db.releaseCovered = false; f.order.payment.status = 'PENDING';
    f.order.status.name = 'Awaiting release';
    await f.collect(2);
    await f.service.receive({ ...request(), storeId: 1, items: [f.item()] }, tech);
    assert.equal(f.stock().inTransit, 1); assert.equal(f.stock().onHand, 1);
    assert.equal(f.order.status.name, 'Awaiting release');
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /must be ready/);
    f.order.status.name = 'Preparing for pickup';
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /unpaid/);
    assert.deepEqual(f.snapshot(), before); f.invariant();
  });

  it('keeps pre-delivery payment requirements and records its installation', async () => {
    const f = fixture(); await f.collect();
    f.db.installationCovered = false;
    f.order.fulfillmentMethod = 'COMPANY_DELIVERY';
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /Delivery payment/);
    (f.order.deliveries as any[]).push({ status: 'SCHEDULED', payment: { status: 'PAID' } });
    const result = await f.service.deliverToInstallation(f.dto(), tech);
    assert.equal(result.installation.id, 71);
    assert.equal(f.order.status.name, 'Preparing for pickup'); f.invariant();
  });

  it('requires the pre-installation installments and any installation delivery charge', async () => {
    const f = fixture(); await f.collect(); f.db.installationCovered = false;
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /Installation installment/);
    f.db.installationCovered = true;
    const payment = { status: 'PENDING' };
    (f.order.deliveries as any[]).push({ type: 'INSTALLATION_OVERRIDE', status: 'PENDING_PAYMENT', payment });
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /delivery charge/);
    assert.deepEqual(f.snapshot(), before);
    payment.status = 'PAID';
    await f.service.deliverToInstallation(f.dto(), tech); assert.equal(f.stock().released, 1);
  });

  it('replays a lost response once, including reordered items and a later address change', async () => {
    const f = fixture(); await f.collect(); await f.collect(1, fixed);
    const dto = f.dto([f.item(), f.item(fixed)]);
    await f.service.deliverToInstallation(dto, tech);
    const before = f.snapshot(); f.job.installationAddress.street = '456 New Street';
    const replay = await f.service.deliverToInstallation({ ...dto, items: [...dto.items].reverse() }, tech);
    assert.equal(replay.replayed, true); assert.equal(replay.installation.address, address);
    assert.deepEqual(f.snapshot(), before);
  });

  it('rejects reuse of a request key with another actor, destination or quantity', async () => {
    const f = fixture(); await f.collect(3);
    const dto = f.dto(); await f.service.deliverToInstallation(dto, tech);
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(dto, admin), /another operation/);
    await assert.rejects(f.service.deliverToInstallation({ ...dto, installationJobId: 99 }, tech), /another operation/);
    await assert.rejects(f.service.deliverToInstallation({ ...dto, installationAddress: 'Other site' }, tech), /another operation/);
    await assert.rejects(f.service.deliverToInstallation({ ...dto, items: [{ ...dto.items[0], quantity: 2 }] }, tech), /another operation/);
    assert.deepEqual(f.snapshot(), before);
  });

  it('handles simultaneous identical confirmations without double delivery', async () => {
    const f = fixture(); await f.collect(); const dto = f.dto();
    const results = await Promise.all([f.service.deliverToInstallation(dto, tech), f.service.deliverToInstallation(dto, tech)]);
    assert.equal(results.filter((r) => r.replayed).length, 1);
    assert.equal(f.stock().released, 1); assert.equal(f.movements.filter((m) => m.type === 'INSTALLATION_DELIVERY').length, 1);
  });

  it('rejects a second confirmation made from the same stock version', async () => {
    const f = fixture(); await f.collect(2);
    const first = f.dto(), second = f.dto();
    const results = await Promise.allSettled([f.service.deliverToInstallation(first, tech), f.service.deliverToInstallation(second, admin)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(f.stock().released, 1); assert.equal(f.stock().inTransit, 1); f.invariant();
  });

  it('rejects warehouse-only parts and over-delivery', async () => {
    const f = fixture();
    await f.service.scan({ ...request(), action: 'RECEIVE', barcode: door, storeId: 1 }, admin);
    await assert.rejects(f.service.deliverToInstallation(f.dto(), admin), /in transit/);
    await f.collect(); const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto([f.item(door, 2)]), admin), /in transit/);
    assert.deepEqual(f.snapshot(), before); f.invariant();
  });

  it('rolls back the entire delivery if a later unit has changed', async () => {
    const f = fixture(); await f.collect(); await f.collect(1, fixed);
    const dto = f.dto([f.item(), { ...f.item(fixed), version: 0 }]), before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(dto, tech), /changed/);
    assert.deepEqual(f.snapshot(), before);
  });

  it('rolls back the entire delivery if a later audit write fails', async () => {
    const f = fixture(); await f.collect(); await f.collect(1, fixed);
    const before = f.snapshot(), create = f.db.warehouseMovement.create; let writes = 0;
    f.db.warehouseMovement.create = async (args: any) => { if (++writes === 2) throw new Error('Audit unavailable'); return create(args); };
    await assert.rejects(f.service.deliverToInstallation(f.dto([f.item(), f.item(fixed)]), tech), /Audit unavailable/);
    assert.deepEqual(f.snapshot(), before);
  });

  it('rejects a mixed-order batch atomically', async () => {
    const f = fixture(); await f.collect(); await f.collect(1, fixed);
    f.pieces[3].idEst = 8;
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto([f.item(), f.item(fixed)]), tech), /one installation/);
    assert.deepEqual(f.snapshot(), before);
  });

  it('rejects wrong, canceled, absent and changed installation destinations', async () => {
    for (const scenario of ['wrong', 'canceled', 'absent', 'changed', 'missingAddress', 'customerPickup']) {
      const f = fixture(); await f.collect(); const dto = f.dto(), before = f.snapshot();
      if (scenario === 'wrong') dto.installationJobId = 999;
      if (scenario === 'canceled') f.job.status = 'CANCELED';
      if (scenario === 'absent') f.order.estimate.installationJob = null;
      if (scenario === 'changed') f.job.installationAddress.street = '456 New Street';
      if (scenario === 'missingAddress') (f.job as any).installationAddress = null;
      if (scenario === 'customerPickup') f.order.fulfillmentMethod = 'CUSTOMER_PICKUP';
      await assert.rejects(f.service.deliverToInstallation(dto, tech), /assigned|address|ready/);
      assert.deepEqual(f.snapshot(), before);
    }
  });

  it('blocks new deliveries during a physical count but still replays a saved confirmation', async () => {
    const f = fixture(); await f.collect(2); const dto = f.dto();
    await f.service.deliverToInstallation(dto, tech);
    await f.service.startCount({ ...request(), scope: 'ALL' }, admin);
    assert.equal((await f.service.deliverToInstallation(dto, tech)).replayed, true);
    const before = f.snapshot();
    await assert.rejects(f.service.deliverToInstallation(f.dto(), tech), /Physical count/);
    assert.deepEqual(f.snapshot(), before);
  });

  it('validates quantities, versions, duplicate barcodes and batch boundaries', async () => {
    const f = fixture(); await f.collect(3); const before = f.snapshot();
    const invalidItems = [[], [null], Array(501).fill(f.item()), [f.item(), { ...f.item(), barcode: `I0${door}` }],
      ...[0, -1, 1.5, 201].map((quantity) => [f.item(door, quantity)]), [{ ...f.item(), version: -1 }]];
    for (const items of invalidItems) await assert.rejects(f.service.deliverToInstallation(f.dto(items as any), tech));
    assert.deepEqual(f.snapshot(), before);
  });

  it('allows only operational staff and gives technicians only the required destination data', async () => {
    const f = fixture(); await f.collect();
    for (const role of ['client', 'dealer']) await assert.rejects(f.service.deliverToInstallation(f.dto(), { id: 9, role: { name: role } } as any), /authorized staff/);
    await assert.rejects(f.service.scan({ ...request(), barcode: door, action: 'RELEASE', storeId: 1 }, tech), /only collect or receive/);
    const pending = await f.service.technicianPending({}, tech);
    assert.deepEqual(pending.items[0].installation, { id: 71, address });
    for (const key of ['customer', 'project', 'orderId', 'price', 'rate', 'payments', 'released']) assert(!(key in pending.items[0]));
    await f.service.deliverToInstallation(f.dto(), tech); f.invariant();
  });

  it('reverses only the latest delivery and preserves its destination in the audit', async () => {
    const f = fixture(); await f.collect(3);
    await f.service.deliverToInstallation(f.dto([f.item(door, 2)]), operator);
    const m = f.movements[f.movements.length - 1];
    await assert.rejects(f.service.undo(m.id, request(), { id: 9, role: { name: 'operator' } }), /own readings/);
    const undo = await f.service.undo(m.id, request(), admin);
    assert.deepEqual(undo.movement.installation, { id: 71, address });
    assert.equal(f.stock().inTransit, 3); assert.equal(f.stock().released, 0); assert.equal(f.stock().onHand, 0);
    await assert.rejects(f.service.undo(m.id, request(), admin), /cannot be undone/); f.invariant();
  });

  it('preserves the recorded address when the installation address later changes', async () => {
    const f = fixture(); await f.collect(); await f.service.deliverToInstallation(f.dto(), tech);
    f.job.installationAddress.street = '456 New Street';
    const history = await f.service.history({}, admin);
    const m = history.items.find((entry) => entry.type === 'INSTALLATION_DELIVERY')!;
    assert.deepEqual(m.installation, { id: 71, address });
    assert.equal((await f.service.unit(door, admin)).installation!.address, '456 New Street, Miami, FL 33101');
  });

  it('keeps ordinary warehouse pickup unchanged without an installation destination', async () => {
    const f = fixture(); f.order.estimate.installationJob = null;
    f.order.fulfillmentMethod = 'CUSTOMER_PICKUP'; f.order.status.name = 'Ready to pick up';
    await f.service.scan({ ...request(), action: 'RECEIVE', barcode: door, storeId: 1 }, admin);
    const result = await f.service.scan({ ...request(), action: 'RELEASE', barcode: door, storeId: 1 }, admin);
    assert.equal(result.movement.installation, null); assert.equal(result.stock.released, 1); f.invariant();
  });
});

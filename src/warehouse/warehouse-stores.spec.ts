import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { WarehouseController } from './warehouse.controller';
import { ROLES_KEY } from '@/auth/roles.decorator';
import { warehouseFixture } from '../../test/warehouse-fixture';

// Estas pruebas aíslan el inventario por ubicación. Las reglas comerciales de
// salida conservan su suite en warehouse.spec.ts y no cambian con este ajuste.
jest.mock('./warehouse-release', () => ({ assertWarehouseRelease: jest.fn(async () => undefined) }));

const admin = { id: 1, role: { name: 'admin' as const } };
const operator = { id: 2, role: { name: 'operator' as const } };
const door = '1029975', fixed = '1096240';
const request = () => ({ requestKey: randomUUID() });
function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  const scan = (action: 'COLLECT' | 'RECEIVE' | 'RELEASE', storeId?: number | null, barcode = door) =>
    service.scan({ ...request(), action, barcode, ...(storeId === undefined ? {} : { storeId }) }, admin);
  const snapshot = () => structuredClone({ stocks: f.stocks, movements: f.movements, balances: f.balances });
  const invariant = () => {
    for (const stock of f.stocks) {
      const assigned = f.balances.filter((b) => b.lineNumber === stock.lineNumber);
      expect(assigned.every((b) => Number.isInteger(b.onHand) && b.onHand >= 0)).toBe(true);
      expect(stock.unassigned >= 0).toBe(true);
      expect(assigned.reduce((n, b) => n + b.onHand, stock.unassigned)).toBe(stock.onHand);
      expect(stock.inTransit + stock.onHand + stock.released <= stock.expectedParts).toBe(true);
    }
  };
  const item = async (barcode = door, quantity = 1) => ({ barcode, quantity, version: (await service.unit(barcode, admin)).version });
  return { ...f, service, scan, snapshot, invariant, item };
}

describe('configurable warehouse stores', () => {
  it('does not seed physical stores and supports any number of configured locations', async () => {
    const f = fixture(); f.stores.splice(0);
    expect(await f.service.stores(admin)).toEqual([]);
    for (const name of ['North', 'South', 'Rack A', 'Rack B', 'Overflow']) await f.service.createStore({ name }, admin);
    expect(await f.service.stores(operator)).toHaveLength(5);
    expect(f.movements).toHaveLength(0);
  });
  it('trims names and prevents duplicate or reserved names', async () => {
    const f = fixture();
    expect((await f.service.createStore({ name: '  New   area  ' }, admin)).name).toBe('New area');
    await expect(f.service.createStore({ name: 'New area' }, admin)).rejects.toThrow('already exists');
    await expect(f.service.createStore({ name: '  Unassigned ' }, admin)).rejects.toThrow('reserved');
  });
  it('restricts store management to administrators in controller and service', async () => {
    const f = fixture();
    expect(Reflect.getMetadata(ROLES_KEY, WarehouseController.prototype.createStore)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, WarehouseController.prototype.updateStore)).toEqual(['admin']);
    await expect(f.service.createStore({ name: 'Extra' }, operator)).rejects.toThrow(ForbiddenException);
    await expect(f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, operator)).rejects.toThrow(ForbiddenException);
  });
  it.each(['client', 'dealer'])('does not expose new operations to %s', async (role) => {
    const f = fixture(), actor: any = { id: 10, role: { name: role } };
    await expect(f.service.stores(actor)).rejects.toThrow(ForbiddenException);
    await expect(f.service.receive({ ...request(), storeId: 1, items: [] }, actor)).rejects.toThrow(ForbiddenException);
    await expect(f.service.transfer({ ...request(), barcode: door, fromStoreId: null, toStoreId: 1, quantity: 1, version: 0 }, actor)).rejects.toThrow(ForbiddenException);
  });
  it('keeps collection in transit without requiring or assigning a store', async () => {
    const f = fixture(); f.stores.splice(0);
    await f.scan('COLLECT');
    const stock = await f.service.unit(door, admin);
    expect(stock).toMatchObject({ inTransit: 1, onHand: 0, unassigned: 0, stores: [] });
    expect(f.balances).toHaveLength(0); f.invariant();
  });
  it('rejects assigning a store at factory collection', async () => {
    const f = fixture();
    await expect(f.scan('COLLECT', 1)).rejects.toThrow('does not assign');
    expect(f.movements).toHaveLength(0);
  });
  it.each([undefined, null, 0, -1, 1.5])('requires an explicit valid receipt destination (%s)', async (storeId) => {
    const f = fixture();
    await expect(f.scan('RECEIVE', storeId)).rejects.toThrow('destination store');
    expect(f.movements).toHaveLength(0);
  });
  it('refuses missing and inactive destinations', async () => {
    const f = fixture(); f.stores[1].isActive = false;
    await expect(f.scan('RECEIVE', 2)).rejects.toThrow('inactive');
    await expect(f.scan('RECEIVE', 99)).rejects.toThrow('not found');
    f.invariant();
  });
  it('splits parts sharing a barcode across stores and receives them only once', async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) await f.scan('COLLECT');
    await f.scan('RECEIVE', 1); await f.scan('RECEIVE', 2);
    const stock = await f.service.unit(door, admin);
    expect(stock).toMatchObject({ inTransit: 1, onHand: 2, unassigned: 0 });
    expect(stock.stores.map((s) => [s.id, s.onHand])).toEqual([[1, 1], [2, 1]]);
    await f.scan('RECEIVE', 1);
    expect(f.balances).toHaveLength(2); f.invariant();
  });
  it('includes the selected store in scan idempotency', async () => {
    const f = fixture(), dto = { ...request(), action: 'RECEIVE' as const, barcode: door, storeId: 1 };
    await f.service.scan(dto, admin);
    expect((await f.service.scan(dto, admin)).replayed).toBe(true);
    await expect(f.service.scan({ ...dto, storeId: 2 }, admin)).rejects.toThrow('another operation');
    expect(f.stocks[0].onHand).toBe(1); f.invariant();
  });
  it('receives selected quantities from transit in one transaction', async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) await f.scan('COLLECT');
    await f.scan('COLLECT', undefined, fixed);
    const result = await f.service.receive({ ...request(), storeId: 2, items: [await f.item(door, 2), await f.item(fixed)] }, operator);
    expect(result).toMatchObject({ parts: 3, units: 2, storeId: 2, replayed: false });
    expect(f.stocks[0]).toMatchObject({ inTransit: 1, onHand: 2, unassigned: 0 });
    expect(f.stocks[3]).toMatchObject({ inTransit: 0, onHand: 1 });
    expect(f.movements.every((m) => m.requestKey.length <= 64)).toBe(true); f.invariant();
  });
  it('does not create direct receipts from the pending-receipt endpoint', async () => {
    const f = fixture();
    await expect(f.service.receive({ ...request(), storeId: 1, items: [await f.item()] }, admin)).rejects.toThrow('in transit');
    expect(f.movements).toHaveLength(0); f.invariant();
  });
  it('rejects duplicate barcodes even when formatted differently', async () => {
    const f = fixture(); await f.scan('COLLECT');
    const item = await f.item();
    await expect(f.service.receive({ ...request(), storeId: 1, items: [item, { ...item, barcode: `I0${door}` }] }, admin)).rejects.toThrow('each unit once');
    f.invariant();
  });
  it('rolls back earlier rows when a later selected unit changed', async () => {
    const f = fixture(); await f.scan('COLLECT'); await f.scan('COLLECT', undefined, fixed);
    const items = [await f.item(), await f.item(fixed)];
    await f.scan('RECEIVE', 2, fixed);
    const before = f.snapshot();
    await expect(f.service.receive({ ...request(), storeId: 1, items }, admin)).rejects.toThrow('changed');
    expect(f.snapshot()).toEqual(before); f.invariant();
  });
  it('rolls back all balances when a later audit write fails', async () => {
    const f = fixture(); await f.scan('COLLECT'); await f.scan('COLLECT', undefined, fixed);
    const dto = { ...request(), storeId: 1, items: [await f.item(), await f.item(fixed)] }, before = f.snapshot();
    const create = f.db.warehouseMovement.create; let writes = 0;
    f.db.warehouseMovement.create = async (args) => { if (++writes === 2) throw new Error('Audit failure'); return create(args); };
    await expect(f.service.receive(dto, admin)).rejects.toThrow('Audit failure');
    expect(f.snapshot()).toEqual(before); f.invariant();
  });
  it('replays a complete batch without another receipt and rejects changed payloads', async () => {
    const f = fixture(); await f.scan('COLLECT'); await f.scan('COLLECT', undefined, fixed);
    const dto = { ...request(), storeId: 1, items: [await f.item(), await f.item(fixed)] };
    await f.service.receive(dto, admin); const before = f.snapshot();
    expect((await f.service.receive({ ...dto, items: [...dto.items].reverse() }, admin)).replayed).toBe(true);
    expect(f.snapshot()).toEqual(before);
    await expect(f.service.receive({ ...dto, storeId: 2 }, admin)).rejects.toThrow('another operation'); f.invariant();
  });
  it('accepts only one of two concurrent receipts for the same selected version', async () => {
    const f = fixture(); await f.scan('COLLECT');
    const item = await f.item();
    const result = await Promise.allSettled([
      f.service.receive({ ...request(), storeId: 1, items: [item] }, admin),
      f.service.receive({ ...request(), storeId: 2, items: [item] }, operator),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, onHand: 1 }); f.invariant();
  });
  it.each([0, -1, 1.5, 201])('rejects invalid receipt quantity %s', async (quantity) => {
    const f = fixture(); await f.scan('COLLECT');
    await expect(f.service.receive({ ...request(), storeId: 1, items: [await f.item(door, quantity)] }, admin)).rejects.toThrow('valid quantities');
    f.invariant();
  });
  it('bounds batch size without imposing a store limit', async () => {
    const f = fixture();
    await expect(f.service.receive({ ...request(), storeId: 1, items: Array.from({ length: 501 }, (_, i) => ({ barcode: String(i + 1), quantity: 1, version: 0 })) }, admin)).rejects.toThrow('500');
  });
  it('assigns legacy Unassigned stock without changing any warehouse totals', async () => {
    const f = fixture(); f.stocks[0].onHand = 2; f.stocks[0].unassigned = 2;
    const result = await f.service.transfer({ ...request(), barcode: door, fromStoreId: null, toStoreId: 2, quantity: 1, version: 0 }, operator);
    expect(result.stock).toMatchObject({ onHand: 2, unassigned: 1, inTransit: 0, released: 0 });
    expect(result.movement).toMatchObject({ type: 'TRANSFER', onHandDelta: 0, transitDelta: 0, quantity: 1 });
    expect(f.movements.filter((m) => m.type === 'RECEIVE')).toHaveLength(0); f.invariant();
  });
  it('transfers all parts to another store and then allows deactivation of the empty source', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1); await f.scan('RECEIVE', 1);
    await f.service.transfer({ ...request(), barcode: door, fromStoreId: 1, toStoreId: 2, quantity: 2, version: f.stocks[0].version }, admin);
    await f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, admin);
    expect((await f.service.unit(door, admin)).stores).toMatchObject([{ id: 2, onHand: 2 }]);
    expect(f.stocks[0].onHand).toBe(2); f.invariant();
  });
  it('refuses transfers from a location that does not hold the requested quantity', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    const dto = { ...request(), barcode: door, fromStoreId: 2, toStoreId: 1, quantity: 1, version: 1 }, before = f.snapshot();
    await expect(f.service.transfer(dto, admin)).rejects.toThrow('Not enough');
    await expect(f.service.transfer({ ...dto, fromStoreId: 1 }, admin)).rejects.toThrow('different');
    await expect(f.service.transfer({ ...dto, fromStoreId: undefined as any }, admin)).rejects.toThrow('different');
    expect(f.snapshot()).toEqual(before);
  });
  it('rejects stale transfers and includes both locations in idempotency', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    const dto = { ...request(), barcode: door, fromStoreId: 1, toStoreId: 2, quantity: 1, version: 1 };
    await expect(f.service.transfer({ ...dto, version: 0 }, admin)).rejects.toThrow('changed');
    await f.service.transfer(dto, admin);
    expect((await f.service.transfer(dto, admin)).replayed).toBe(true);
    await expect(f.service.transfer({ ...dto, quantity: 2 }, admin)).rejects.toThrow('another operation'); f.invariant();
  });
  it('undoes a transfer with exactly reversed store balances', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    const result = await f.service.transfer({ ...request(), barcode: door, fromStoreId: 1, toStoreId: 2, quantity: 1, version: 1 }, admin);
    const undo = await f.service.undo(result.movement.id, request(), admin);
    expect(undo.stock.stores).toMatchObject([{ id: 1, onHand: 1 }]);
    expect(undo.movement).toMatchObject({ type: 'UNDO', quantity: 1, fromStore: { id: 2 }, toStore: { id: 1 } }); f.invariant();
  });
  it('undoes a complete multi-part receipt back to transit', async () => {
    const f = fixture(); await f.scan('COLLECT'); await f.scan('COLLECT');
    await f.service.receive({ ...request(), storeId: 1, items: [await f.item(door, 2)] }, admin);
    await f.service.undo(f.movements[f.movements.length - 1].id, request(), admin);
    expect(f.stocks[0]).toMatchObject({ inTransit: 2, onHand: 0, unassigned: 0 }); f.invariant();
  });
  it('does not undo a movement into a deactivated store', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    const result = await f.service.transfer({ ...request(), barcode: door, fromStoreId: 1, toStoreId: 2, quantity: 1, version: 1 }, admin);
    await f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, admin);
    await expect(f.service.undo(result.movement.id, request(), admin)).rejects.toThrow('inactive'); f.invariant();
  });
  it('blocks deactivation with stock and preserves location IDs across renaming', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    await expect(f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, admin)).rejects.toThrow('Transfer all parts');
    await f.service.updateStore(1, { name: 'North area', isActive: true, version: 0 }, admin);
    expect((await f.service.unit(door, admin)).stores[0]).toMatchObject({ id: 1, name: 'North area', onHand: 1 });
    await expect(f.service.updateStore(1, { name: 'Changed', isActive: true, version: 0 }, admin)).rejects.toThrow('Refresh'); f.invariant();
  });
  it('reports balances and filters Unassigned separately from assigned parts', async () => {
    const f = fixture(); f.stocks[0].onHand = 2; f.stocks[0].unassigned = 2;
    await f.service.transfer({ ...request(), barcode: door, fromStoreId: null, toStoreId: 1, quantity: 1, version: 0 }, admin);
    const stores = await f.service.stores(admin);
    expect(stores.find((s) => s.id === 1)).toMatchObject({ onHand: 1, units: 1 });
    expect((await f.service.inventory({ storeId: 'unassigned' }, admin)).total).toBe(1);
    expect((await f.service.inventory({ storeId: '1' }, admin)).total).toBe(1);
    expect((await f.service.inventory({ storeId: '2' }, admin)).total).toBe(0);
    expect((await f.service.inventory({}, admin)).summary).toMatchObject({ onHand: 2, unassigned: 1 }); f.invariant();
  });
  it('requires explicit source selection for releases and never consumes a different store', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    await expect(f.scan('RELEASE')).rejects.toThrow('source store');
    await expect(f.scan('RELEASE', 2)).rejects.toThrow('Not enough');
    await expect(f.scan('RELEASE', null)).rejects.toThrow('Unassigned');
    await f.scan('RELEASE', 1);
    expect(f.stocks[0]).toMatchObject({ onHand: 0, released: 1 }); f.invariant();
  });
  it('allows an explicit Unassigned release for legacy stock', async () => {
    const f = fixture(); f.stocks[0].onHand = 1; f.stocks[0].unassigned = 1;
    await f.scan('RELEASE', null);
    expect(f.stocks[0]).toMatchObject({ onHand: 0, unassigned: 0, released: 1 }); f.invariant();
  });
  it('pauses batch receipts and transfers while a physical count is open', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1); await f.scan('COLLECT');
    const item = await f.item();
    await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, operator);
    await expect(f.service.receive({ ...request(), storeId: 2, items: [item] }, admin)).rejects.toThrow('is open');
    await expect(f.service.transfer({ ...request(), barcode: door, fromStoreId: 1, toStoreId: 2, quantity: 1, version: item.version }, admin)).rejects.toThrow('is open'); f.invariant();
  });
  it('adjusts only the counted store while preserving parts in other stores', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1); await f.scan('RECEIVE', 1); await f.scan('RECEIVE', 2);
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    await f.service.countScan(count.id, { ...request(), barcode: door }, operator);
    const review = await f.service.count(count.id, {}, admin);
    expect(review).toMatchObject({ expected: 2, counted: 1, scope: 'STORE', store: { id: 1 } });
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'One part missing in Main' }, admin);
    expect((await f.service.unit(door, admin)).stores.map((s) => [s.id, s.onHand])).toEqual([[1, 1], [2, 1]]);
    expect(f.stocks[0].onHand).toBe(2); f.invariant();
  });
  it('adds found parts to the counted store without changing other locations', async () => {
    const f = fixture(); await f.scan('RECEIVE', 2);
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    await f.service.countScan(count.id, { ...request(), barcode: door }, admin);
    const review = await f.service.count(count.id, {}, admin);
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'Found part verified' }, admin);
    expect((await f.service.unit(door, admin)).stores.map((s) => [s.id, s.onHand])).toEqual([[1, 1], [2, 1]]); f.invariant();
  });
  it('counts Unassigned without reducing any named store', async () => {
    const f = fixture(); f.stocks[0].onHand = 2; f.stocks[0].unassigned = 2;
    await f.service.transfer({ ...request(), barcode: door, fromStoreId: null, toStoreId: 1, quantity: 1, version: 0 }, admin);
    const count = await f.service.startCount({ ...request(), scope: 'UNASSIGNED' }, admin), review = await f.service.count(count.id, {}, admin);
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'Missing unassigned part' }, admin);
    expect(f.stocks[0]).toMatchObject({ onHand: 1, unassigned: 0 });
    expect((await f.service.unit(door, admin)).stores[0].onHand).toBe(1); f.invariant();
  });
  it('does not guess which store lost parts in a legacy all-warehouse count', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1);
    const count = await f.service.startCount(request(), admin), review = await f.service.count(count.id, {}, admin);
    await expect(f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'Missing part' }, admin)).rejects.toThrow('affected store separately');
    expect(f.counts[0].status).toBe('OPEN'); expect(f.stocks[0].onHand).toBe(1); f.invariant();
  });
  it('preserves compatibility with pre-store counts of legacy Unassigned stock', async () => {
    const f = fixture(); f.stocks[0].onHand = 1; f.stocks[0].unassigned = 1;
    const count = await f.service.startCount(request(), admin), review = await f.service.count(count.id, {}, admin);
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'Verified missing legacy stock' }, admin);
    expect(f.stocks[0]).toMatchObject({ onHand: 0, unassigned: 0 }); f.invariant();
  });
  it('cannot deactivate an empty store with an open count', async () => {
    const f = fixture(), count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    await expect(f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, admin)).rejects.toThrow('physical count');
    await f.service.closeCount(count.id, { action: 'CANCEL' }, admin);
    await f.service.updateStore(1, { name: 'Main', isActive: false, version: 0 }, admin);
    expect(f.stores[0].isActive).toBe(false);
  });
  it('does not count the same capacity again in a different store', async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) await f.scan('RECEIVE', 1);
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 2 }, admin);
    await expect(f.service.countScan(count.id, { ...request(), barcode: door }, admin)).rejects.toThrow('exceeds'); f.invariant();
  });
  it('rejects inconsistent store balances instead of compounding them', async () => {
    const f = fixture(); await f.scan('RECEIVE', 1); f.stocks[0].unassigned = 1;
    await expect(f.scan('RECEIVE', 1)).rejects.toThrow('do not match');
    expect(f.stocks[0].onHand).toBe(1);
  });
  it('does not present in-transit parts as allocated to a store', async () => {
    const f = fixture(); await f.scan('COLLECT');
    await expect(f.service.inventory({ view: 'in_transit', storeId: '1' }, admin)).rejects.toThrow('no store yet');
    expect((await f.service.inventory({ view: 'in_transit' }, admin)).total).toBe(1);
  });

});

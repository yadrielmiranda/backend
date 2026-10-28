import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const line = '880001';
const request = () => ({ requestKey: randomUUID() });
const partial = { cycle: 0, partialReason: 'OTHER' as const, note: 'Return for remaining parts' };

function fixture() {
  const f = warehouseFixture();
  f.externalPos.push({ id: 1, poNumber: 'EX100', orderId: null, orderName: 'Earlier project', supplierName: 'ECO' });
  f.stocks.push({
    lineNumber: line, pieceId: null, externalPoId: 1,
    mark: 'D1', description: 'French Door 600 XX\nSize: 72 x 80\nBronze', panels: 2,
    expectedParts: 3, inTransit: 0, onHand: 0, unassigned: 0, released: 0, version: 0, updatedAt: new Date(),
  });
  const service = new WarehouseService(f.db);
  const scan = (action: 'COLLECT' | 'RECEIVE' | 'RELEASE', barcode = `${line}-DOOR`, storeId = 1) =>
    service.scan({ ...request(), barcode, action, ...(action === 'COLLECT' ? {} : { storeId }) }, admin);
  return { ...f, service, scan };
}

describe('External PO warehouse inventory', () => {
  it('collects, receives, transfers, releases and undoes external parts without a commercial order', async () => {
    const f = fixture();
    const commercialLookup = jest.spyOn(f.db.order, 'findUnique');
    await f.scan('COLLECT');
    await f.scan('RECEIVE');
    const stock = await f.service.unit(line, admin);
    expect(stock).toMatchObject({
      source: 'EXTERNAL', externalPoId: 1, pieceId: null, orderId: null, poNumber: 'EX100',
      project: 'Earlier project', product: 'French Door 600 XX', supplierName: 'ECO',
      description: 'French Door 600 XX\nSize: 72 x 80\nBronze', expectedParts: 3, onHand: 1, inTransit: 0,
      installation: null, system: '', configuration: '',
    });
    await f.service.transfer({ ...request(), barcode: line, quantity: 1, fromStoreId: 1, toStoreId: 2, version: stock.version }, admin);
    const release = await f.scan('RELEASE', line, 2);
    expect(release.stock).toMatchObject({ onHand: 0, released: 1 });
    const undone = await f.service.undo(release.movement.id, request(), admin);
    expect(undone.stock).toMatchObject({ onHand: 1, released: 0, stores: [{ id: 2, onHand: 1 }] });
    expect(commercialLookup).not.toHaveBeenCalled();
    expect((await f.service.history({ lineNumber: line }, admin)).total).toBe(5);
    expect(f.orders).toHaveLength(1);
  });

  it('searches full external descriptions and groups sources with colliding numeric IDs independently', async () => {
    const f = fixture();
    await f.scan('RECEIVE');
    await f.scan('RECEIVE', '1029975-DOOR');
    const external = await f.service.inventory({ source: 'EXTERNAL', search: 'Bronze' }, admin);
    expect(external.items.map((s) => s.lineNumber)).toEqual([line]);
    expect((await f.service.inventory({ source: 'ORDER' }, admin)).items.map((s) => s.lineNumber)).toEqual(['1029975']);
    const grouped = await f.service.inventoryByPo({}, admin);
    expect(grouped.items.map((g) => g.key).sort()).toEqual(['external:1', 'order:1']);
    expect(grouped.items.find((g) => g.source === 'EXTERNAL')).toMatchObject({ externalPoId: 1, orderId: null, project: 'Earlier project' });
    expect((await f.service.inventory({ search: 'Earlier project' }, admin)).total).toBe(1);
    expect((await f.service.inventory({ search: 'EX100' }, admin)).total).toBe(1);
  });

  it('counts external stock, applies corrections and requires parts before moving an unknown unit', async () => {
    const f = fixture();
    const row = f.stocks.find((s) => s.lineNumber === line)!;
    row.expectedParts = null;
    await expect(f.scan('COLLECT')).rejects.toThrow('expected physical parts');
    await f.service.setParts(line, { ...request(), expectedParts: 3, version: 0, reason: 'Confirmed physical parts' }, admin);
    await f.scan('RECEIVE');
    const count = await f.service.startCount({ ...request(), scope: 'ALL' }, admin);
    await f.service.countScan(count.id, { ...request(), barcode: line, partType: 'DOOR' }, admin);
    await f.service.countScan(count.id, { ...request(), barcode: line, partType: 'DOOR' }, admin);
    const summary = await f.service.count(count.id, {}, admin);
    expect(summary.items[0].stock.source).toBe('EXTERNAL');
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: summary.revision, reason: 'Found another part' }, admin);
    expect((await f.service.unit(line, admin)).onHand).toBe(2);
  });

  it('delivers external parts directly from transit without an installation or warehouse entry', async () => {
    const f = fixture();
    const commercialLookup = jest.spyOn(f.db.order, 'findUnique');
    await f.scan('COLLECT');
    const pending = await f.service.technicianPending({}, tech);
    expect(pending.items[0]).toMatchObject({ source: 'EXTERNAL', externalPoId: 1, installation: null });
    await expect(f.service.scan({ ...request(), action: 'RELEASE', barcode: line, storeId: 1 }, tech)).rejects.toThrow('no parts');
    const dto = { ...request(), items: [{ barcode: line, quantity: 1, version: 1 }] };
    expect(await f.service.deliverToInstallation(dto, tech)).toMatchObject({ units: 1, parts: 1, installation: null, replayed: false });
    expect(await f.service.deliverToInstallation(dto, tech)).toMatchObject({ installation: null, replayed: true });
    expect((await f.service.unit(line, admin))).toMatchObject({ inTransit: 0, onHand: 0, released: 1 });
    expect(f.balances).toHaveLength(0); expect(commercialLookup).not.toHaveBeenCalled();
    const movements = f.movements.filter((m) => m.type === 'INSTALLATION_DELIVERY');
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ actorId: tech.id, quantity: 1, transitDelta: -1, onHandDelta: 0, releasedDelta: 1, installationJobId: null, installationAddress: null });
    expect(movements[0].createdAt).toBeInstanceOf(Date);
    const history = await f.service.history({ lineNumber: line }, admin);
    expect(history.items.find((m) => m.type === 'INSTALLATION_DELIVERY')).toMatchObject({ lineNumber: line, quantity: 1, actorId: tech.id, installation: null });
    expect(await f.service.unit(line, admin)).toMatchObject({ source: 'EXTERNAL', externalPoId: 1, poNumber: 'EX100' });
    const undone = await f.service.undo(movements[0].id, request(), admin);
    expect(undone.stock).toMatchObject({ inTransit: 1, onHand: 0, released: 0 });
    expect(undone.movement.installation).toBeNull();
  });

  it('rejects a fabricated installation destination for external parts', async () => {
    const f = fixture(); await f.scan('COLLECT');
    const before = structuredClone({ stocks: f.stocks, movements: f.movements });
    await expect(f.service.deliverToInstallation({
      ...request(), installationJobId: 1, installationAddress: '1 Test St',
      items: [{ barcode: line, quantity: 1, version: 1 }],
    }, tech)).rejects.toThrow(/assigned|destination|installation/i);
    await expect(f.service.deliverToInstallation({
      ...request(), installationAddress: '1 Test St',
      items: [{ barcode: line, quantity: 1, version: 1 }],
    }, tech)).rejects.toThrow(/address|destination/i);
    expect({ stocks: f.stocks, movements: f.movements }).toEqual(before);
  });

  it.each([1, 7])('rejects an internal order mixed with external PO %s even when source IDs collide', async (externalId) => {
    const f = fixture();
    f.externalPos[0].id = externalId;
    f.stocks.find((stock) => stock.lineNumber === line)!.externalPoId = externalId;
    await f.scan('COLLECT'); await f.scan('COLLECT', '1029975-DOOR');
    const before = structuredClone({ stocks: f.stocks, movements: f.movements });
    await expect(f.service.deliverToInstallation({
      ...request(), items: [
        { barcode: line, quantity: 1, version: 1 },
        { barcode: '1029975', quantity: 1, version: 1 },
      ],
    }, tech)).rejects.toThrow(/one .*PO|one order/i);
    expect({ stocks: f.stocks, movements: f.movements }).toEqual(before);
  });

  it('rejects parts from two external POs atomically', async () => {
    const f = fixture(), secondLine = '880002';
    f.externalPos.push({ ...f.externalPos[0], id: 2, poNumber: 'EX200' });
    f.stocks.push({ ...f.stocks.find((stock) => stock.lineNumber === line), lineNumber: secondLine, externalPoId: 2 });
    await f.scan('COLLECT'); await f.scan('COLLECT', `${secondLine}-DOOR`);
    const before = structuredClone({ stocks: f.stocks, movements: f.movements });
    await expect(f.service.deliverToInstallation({
      ...request(), items: [
        { barcode: line, quantity: 1, version: 1 },
        { barcode: secondLine, quantity: 1, version: 1 },
      ],
    }, tech)).rejects.toThrow(/one .*PO|one order/i);
    expect({ stocks: f.stocks, movements: f.movements }).toEqual(before);
  });
});

describe('Mixed internal and external factory pickups', () => {
  it('keeps progress separate by source and supports external close, reopen and collect undo', async () => {
    const f = fixture();
    const preview = await f.service.factoryPickupPo('EX100', admin);
    expect(preview).toMatchObject({ key: 'external:1', source: 'EXTERNAL', orderId: null, externalPoId: 1, parts: 3 });
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374', 'EX100'], technicianIds: [3] }, admin);
    expect(run.orders.map((po) => po.key)).toEqual(['order:1', 'external:1']);
    const read = await f.service.factoryPickupScan(run.id, { ...request(), barcode: line, partType: 'DOOR' }, tech);
    expect(read.kind).toBe('COLLECTED');
    if (read.kind !== 'COLLECTED') throw new Error('Expected collection');
    expect(read.pickup.orders.find((po) => po.key === 'external:1')).toMatchObject({ collectedParts: 1, remainingParts: 2 });
    expect(read.pickup.orders.find((po) => po.key === 'order:1')?.collectedParts).toBe(0);
    await expect(f.service.setParts(line, { ...request(), expectedParts: 4, version: 1, reason: 'Additional part' }, admin)).rejects.toThrow('Finish the active factory pickup');
    await expect(f.scan('COLLECT')).rejects.toThrow('assigned factory pickup');
    await f.service.undo(read.movement.id, request(), admin);
    expect((await f.service.factoryPickup(run.id, tech)).collectedParts).toBe(0);
    await f.service.finishFactoryPickup(run.id, partial, tech);
    const reopened = await f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin);
    expect(reopened.cycle).toBe(1);
    await f.service.factoryPickupScan(run.id, { ...request(), barcode: line, partType: 'DOOR' }, tech);
    expect((await f.service.factoryPickup(run.id, tech)).collectedParts).toBe(1);
  });

  it('adds a scanned external PO to an internal pickup and protects active claims when reopening', async () => {
    const f = fixture();
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    const candidate = await f.service.factoryPickupScan(run.id, { ...request(), barcode: line, partType: 'DOOR' }, tech);
    expect(candidate).toMatchObject({ kind: 'PO_NOT_INCLUDED', candidate: { key: 'external:1', orderId: null, externalPoId: 1 } });
    await f.service.factoryPickupScan(run.id, { ...request(), barcode: line, partType: 'DOOR', addPo: true }, tech);
    await expect(f.service.startFactoryPickup({ poNumbers: ['EX100'], technicianIds: [3] }, admin)).rejects.toThrow('another active');
    await f.service.finishFactoryPickup(run.id, partial, tech);
    const second = await f.service.startFactoryPickup({ poNumbers: ['EX100'], technicianIds: [3] }, admin);
    await expect(f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin)).rejects.toThrow(`PO EX100 is already in active pickup #${second.id}`);
  });
});

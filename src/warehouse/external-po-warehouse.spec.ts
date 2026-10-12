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
  const scan = (action: 'COLLECT' | 'RECEIVE' | 'RELEASE', barcode = line, storeId = 1) =>
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
    await f.scan('RECEIVE', '1029975');
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
    await f.service.countScan(count.id, { ...request(), barcode: line }, admin);
    await f.service.countScan(count.id, { ...request(), barcode: line }, admin);
    const summary = await f.service.count(count.id, {}, admin);
    expect(summary.items[0].stock.source).toBe('EXTERNAL');
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: summary.revision, reason: 'Found another part' }, admin);
    expect((await f.service.unit(line, admin)).onHand).toBe(2);
  });

  it('keeps external units out of installation deliveries and restricts technician releases', async () => {
    const f = fixture();
    await f.scan('COLLECT');
    const pending = await f.service.technicianPending({}, tech);
    expect(pending.items[0]).toMatchObject({ source: 'EXTERNAL', externalPoId: 1, installation: null });
    await expect(f.service.deliverToInstallation({
      ...request(), installationJobId: 1, installationAddress: '1 Test St',
      items: [{ barcode: line, quantity: 1, version: 1 }],
    }, tech)).rejects.toThrow('External POs do not have an installation');
    await expect(f.service.scan({ ...request(), action: 'RELEASE', barcode: line, storeId: 1 }, tech)).rejects.toThrow('Technicians can only');
    expect((await f.service.unit(line, admin)).inTransit).toBe(1);
  });
});

describe('Mixed internal and external factory pickups', () => {
  it('keeps progress separate by source and supports external close, reopen and collect undo', async () => {
    const f = fixture();
    const preview = await f.service.factoryPickupPo('EX100', admin);
    expect(preview).toMatchObject({ key: 'external:1', source: 'EXTERNAL', orderId: null, externalPoId: 1, parts: 3 });
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374', 'EX100'], technicianIds: [3] }, admin);
    expect(run.orders.map((po) => po.key)).toEqual(['order:1', 'external:1']);
    const read = await f.service.factoryPickupScan(run.id, { ...request(), barcode: line }, tech);
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
    await f.service.factoryPickupScan(run.id, { ...request(), barcode: line }, tech);
    expect((await f.service.factoryPickup(run.id, tech)).collectedParts).toBe(1);
  });

  it('adds a scanned external PO to an internal pickup and protects active claims when reopening', async () => {
    const f = fixture();
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    const candidate = await f.service.factoryPickupScan(run.id, { ...request(), barcode: line }, tech);
    expect(candidate).toMatchObject({ kind: 'PO_NOT_INCLUDED', candidate: { key: 'external:1', orderId: null, externalPoId: 1 } });
    await f.service.factoryPickupScan(run.id, { ...request(), barcode: line, addPo: true }, tech);
    await expect(f.service.startFactoryPickup({ poNumbers: ['EX100'], technicianIds: [3] }, admin)).rejects.toThrow('another active');
    await f.service.finishFactoryPickup(run.id, partial, tech);
    const second = await f.service.startFactoryPickup({ poNumbers: ['EX100'], technicianIds: [3] }, admin);
    await expect(f.service.reopenFactoryPickup(run.id, { cycle: 0 }, admin)).rejects.toThrow(`PO EX100 is already in active pickup #${second.id}`);
  });
});

import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { recordDirectFactoryPickup } from './factory-fulfillment';

const admin = { id: 1, role: { name: 'admin' as const } };
const firstTech = { id: 3, role: { name: 'technician' as const } };
const secondTech = { id: 4, role: { name: 'technician' as const } };
const line = '1029975';
const request = () => ({ requestKey: randomUUID() });
const partial = { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' as const };
const signature = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];
function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  const start = (technicianId: number) => service.startFactoryPickup({
    poNumbers: ['281374'], technicianIds: [technicianId],
  }, admin);
  const collect = (pickupId: number, type: 'DOOR' | 'FRAME', actor = firstTech) =>
    service.factoryPickupScan(pickupId, { ...request(), barcode: `${line}-${type}` }, actor);
  const deliver = (type: 'DOOR' | 'FRAME', actor = firstTech) => service.technicianDeliverToCustomer({
    ...request(), source: 'TRANSIT', firstName: 'Maria', lastName: 'Recipient', signatureStrokes: signature,
    items: [{ barcode: line, quantity: 1, parts: { [type]: 1 }, version: f.stocks[0].version }],
  }, actor);
  return { ...f, service, start, collect, deliver };
}

describe('physical part counts and pickup ownership', () => {
  it('keeps linear material out of door/frame tracking even when its diagram family is stale', async () => {
    const f = fixture();
    f.pieces[0].prod.kind = 'LINEAR_MATERIAL';
    expect((await f.service.unit(line, admin)).partTracking.expected).toEqual({ WINDOW: 3 });
    await expect(f.service.scan({
      ...request(), barcode: `${line}-DOOR`, action: 'RECEIVE', storeId: 1,
    }, admin)).rejects.toThrow('not expected');
    await f.service.scan({ ...request(), barcode: `${line}-WINDOW`, action: 'RECEIVE', storeId: 1 }, admin);
    expect(f.stocks[0]).toMatchObject({ expectedParts: 3, onHand: 1 });
    const direct = fixture();
    direct.pieces[0].prod.kind = 'LINEAR_MATERIAL';
    await recordDirectFactoryPickup(direct.db, 1, 7, admin.id);
    expect((await direct.service.unit(line, admin)).partTracking.released).toEqual({ WINDOW: 3 });
  });

  it.each(['RECEIVE', 'RELEASE'] as const)('asks for a type for a single old-label %s from a mixed source', async (action) => {
    const f = fixture();
    for (const type of ['DOOR', 'FRAME']) await f.service.scan({
      ...request(), barcode: `${line}-${type}`, action: action === 'RECEIVE' ? 'COLLECT' : 'RECEIVE',
      ...(action === 'RELEASE' ? { storeId: 1 } : {}),
    }, admin);
    const before = structuredClone({ stocks: f.stocks, balances: f.balances, movements: f.movements });
    const scan = { ...request(), barcode: `I${line}`, action, storeId: 1 };
    await expect(f.service.scan(scan, admin)).rejects.toMatchObject({
      response: { code: 'FACTORY_PART_TYPE_REQUIRED', types: ['DOOR', 'FRAME'] },
    });
    expect({ stocks: f.stocks, balances: f.balances, movements: f.movements }).toEqual(before);
    await f.service.scan({ ...scan, partType: 'FRAME' }, admin);
    const stock = await f.service.unit(line, admin);
    expect(action === 'RECEIVE' ? stock.partTracking.onHand : stock.partTracking.released).toEqual({ FRAME: 1 });
    expect(action === 'RECEIVE' ? stock.partTracking.inTransit : stock.partTracking.onHand).toEqual({ DOOR: 1 });
  });

  it('receives a new door directly without consuming the frame still in transit', async () => {
    const f = fixture();
    await f.service.scan({ ...request(), barcode: `${line}-FRAME`, action: 'COLLECT' }, admin);
    await f.service.scan({ ...request(), barcode: `${line}-DOOR`, action: 'RECEIVE', storeId: 1 }, admin);
    expect(await f.service.unit(line, admin)).toMatchObject({
      expectedParts: 3, inTransit: 1, onHand: 1,
      partTracking: { inTransit: { FRAME: 1 }, onHand: { DOOR: 1 } },
    });
    expect(f.movements[1]).toMatchObject({ transitDelta: 0, onHandDelta: 1 });
  });

  it('reports and reconciles a composition difference even when the total count is unchanged', async () => {
    const f = fixture();
    for (let index = 0; index < 2; index++) await f.service.scan({
      ...request(), barcode: `${line}-DOOR`, action: 'RECEIVE', storeId: 1,
    }, admin);
    const count = await f.service.startCount({ ...request(), scope: 'STORE', storeId: 1 }, admin);
    const read = (type: string) => f.service.countScan(count.id, { ...request(), barcode: `${line}-${type}` }, admin);
    await read('DOOR');
    const frame = await read('FRAME');
    await f.service.undo(frame.movement.id, request(), admin);
    expect((await f.service.count(count.id, {}, admin)).items[0].countedByType).toMatchObject({ DOOR: 1, FRAME: 0 });
    await read('FRAME');
    const review = await f.service.count(count.id, { differences: 'true' }, admin);
    expect(review).toMatchObject({ expected: 2, counted: 2, differences: 1, total: 1 });
    expect(review.items[0]).toMatchObject({ difference: 0, partDifference: true,
      expectedByType: { DOOR: 2, FRAME: 0 }, countedByType: { DOOR: 1, FRAME: 1 } });
    await expect(f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision }, admin)).rejects.toThrow('reason');
    await f.service.closeCount(count.id, { action: 'COMPLETE', revision: review.revision, reason: 'Verified physical labels' }, admin);
    expect(f.stocks[0]).toMatchObject({ expectedParts: 3, onHand: 2, inTransit: 0, released: 0 });
    expect((await f.service.unit(line, admin)).partTracking.onHand).toEqual({ DOOR: 1, FRAME: 1 });
  });

  it('keeps a frame collected by one crew unavailable to a second crew holding only a door', async () => {
    const f = fixture(), first = await f.start(firstTech.id);
    await f.collect(first.id, 'FRAME');
    await f.service.finishFactoryPickup(first.id, partial, firstTech);
    const second = await f.start(secondTech.id);
    await f.collect(second.id, 'DOOR', secondTech);
    const options = await f.service.technicianCustomerDeliveryOptions({}, secondTech);
    expect(options.items[0].lines[0]).toMatchObject({ inTransit: 1, partTracking: { inTransit: { DOOR: 1, FRAME: 0 } } });
    await expect(f.deliver('FRAME', secondTech)).rejects.toThrow('not available');
    expect(f.customerDeliveries).toHaveLength(0);
    await f.deliver('DOOR', secondTech);
    expect((await f.service.technicianCustomerDeliveryOptions({}, secondTech)).items).toEqual([]);
    expect((await f.service.technicianCustomerDeliveryOptions({}, firstTech)).items[0].lines[0])
      .toMatchObject({ inTransit: 1, partTracking: { inTransit: { FRAME: 1 } } });
    await f.deliver('FRAME');
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, released: 2, expectedParts: 3 });
  });

  it('refines a crew’s legacy unknown lot without consuming another crew’s known door', async () => {
    const f = fixture(), first = await f.start(firstTech.id);
    await f.collect(first.id, 'DOOR');
    // Represent an existing pre-upgrade reading and stock with no recorded part type.
    f.movements[0].partDetails = null;
    f.stocks[0].partBalances = null;
    const originalMovement = structuredClone(f.movements[0]);
    await f.service.finishFactoryPickup(first.id, partial, firstTech);
    const second = await f.start(secondTech.id);
    await f.collect(second.id, 'DOOR', secondTech);
    await f.deliver('DOOR');
    expect(f.movements[0]).toEqual(originalMovement);
    expect((await f.service.technicianCustomerDeliveryOptions({}, firstTech)).items).toEqual([]);
    expect((await f.service.technicianCustomerDeliveryOptions({}, secondTech)).items[0].lines[0])
      .toMatchObject({ inTransit: 1, partTracking: { inTransit: { DOOR: 1, UNKNOWN: 0 } } });
    expect((await f.service.unit(line, admin)).partTracking).toMatchObject({
      inTransit: { DOOR: 1 }, released: { DOOR: 1 },
    });
  });
});

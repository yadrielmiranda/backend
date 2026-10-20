import { createHash, randomUUID } from 'crypto';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';

const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const door = '1029975', sliding = '1029967', windowLine = '1029968';
const request = () => ({ requestKey: randomUUID() });
const signature = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];
function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  const scan = (barcode: string, action: 'COLLECT' | 'RECEIVE' | 'RELEASE' = 'RECEIVE') =>
    service.scan({ ...request(), barcode, action, ...(action === 'COLLECT' ? {} : { storeId: 1 }) }, admin);
  const unit = (line = door) => service.unit(line, admin);
  const snapshot = () => structuredClone({ stocks: f.stocks, balances: f.balances, movements: f.movements, deliveries: f.customerDeliveries });
  return { ...f, service, scan, unit, snapshot };
}

describe('factory panels and frames through warehouse operations', () => {
  it('requires two door panels and the frame, rejecting a third panel without a write', async () => {
    const f = fixture();
    await f.scan(`${door}-DOOR`);
    await f.scan(`${door}-DOOR`);
    const before = f.snapshot();
    await expect(f.scan(`${door}-DOOR`)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(await f.unit()).toMatchObject({ onHand: 2, expectedParts: 3, pending: 1, state: 'PARTIAL' });
    await f.scan(`${door}-FRAME`);
    expect(await f.unit()).toMatchObject({
      onHand: 3, expectedParts: 3, state: 'COMPLETE',
      partTracking: { expected: { DOOR: 2, FRAME: 1 }, onHand: { DOOR: 2, FRAME: 1 } },
    });
  });

  it('accepts the frame first but never a second frame', async () => {
    const f = fixture();
    await f.scan(`${sliding}-FRAME`);
    await expect(f.scan(`${sliding}-FRAME`)).rejects.toThrow();
    for (let i = 0; i < 3; i++) await f.scan(`${sliding}-DOOR`);
    expect(await f.unit(sliding)).toMatchObject({ onHand: 4, expectedParts: 4, state: 'COMPLETE' });
  });

  it('asks for an explicit type on old door labels and accepts that choice', async () => {
    const f = fixture(), before = f.snapshot();
    await expect(f.scan(`I${door}`)).rejects.toMatchObject({
      response: { code: 'FACTORY_PART_TYPE_REQUIRED', types: ['DOOR', 'FRAME'] },
    });
    expect(f.snapshot()).toEqual(before);
    await f.service.scan({ ...request(), barcode: `I${door}`, partType: 'DOOR', action: 'RECEIVE', storeId: 1 }, admin);
    await f.service.scan({ ...request(), barcode: door, partType: 'FRAME', action: 'RECEIVE', storeId: 1 }, admin);
    expect(await f.unit()).toMatchObject({ onHand: 2, partTracking: { onHand: { DOOR: 1, FRAME: 1 } } });
  });

  it('rejects a selected type that contradicts the scanned suffix', async () => {
    const f = fixture();
    await expect(f.service.scan({
      ...request(), barcode: `${door}-DOOR`, partType: 'FRAME', action: 'RECEIVE', storeId: 1,
    }, admin)).rejects.toThrow();
    expect(f.movements).toHaveLength(0);
  });

  it('uses WINDOW for other products without recalculating their saved quantity', async () => {
    const f = fixture();
    f.stocks[2].expectedParts = 3;
    for (const code of [`I${windowLine}`, windowLine, `${windowLine}-WINDOW`]) await f.scan(code);
    expect(await f.unit(windowLine)).toMatchObject({
      expectedParts: 3, onHand: 3, partTracking: { expected: { WINDOW: 3 }, onHand: { WINDOW: 3 } },
    });
    await expect(f.scan(`${windowLine}-FRAME`)).rejects.toThrow();
    await expect(f.scan(`${door}-WINDOW`)).rejects.toThrow();
  });

  it('does not initialize or alter existing data just by looking up the new barcode', async () => {
    const f = fixture();
    f.stocks[0].inTransit = 1;
    f.stocks[0].onHand = 1;
    f.balances.push({ lineNumber: door, storeId: 1, onHand: 1 });
    f.stocks[0].released = 1;
    f.movements.push({ id: 99, lineNumber: door, quantity: 1, type: 'COLLECT', historical: true });
    const before = f.snapshot();
    expect(await f.unit(`${door}-FRAME`)).toMatchObject({
      inTransit: 1, onHand: 1, released: 1,
      partTracking: { inTransit: { UNKNOWN: 1 }, onHand: { UNKNOWN: 1 }, released: { UNKNOWN: 1 } },
    });
    expect(f.snapshot()).toEqual(before);
  });

  it('receives legacy transit by its observed type without changing earlier movements', async () => {
    const f = fixture();
    f.stocks[0].inTransit = 3;
    f.movements.push({ id: 90, lineNumber: door, quantity: 3, type: 'COLLECT', historical: true });
    const historical = structuredClone(f.movements[0]);
    await f.scan(`${door}-DOOR`);
    await f.scan(`${door}-DOOR`);
    await expect(f.scan(`${door}-DOOR`)).rejects.toThrow();
    await f.scan(`${door}-FRAME`);
    expect(f.movements[0]).toEqual(historical);
    expect(await f.unit()).toMatchObject({ inTransit: 0, onHand: 3, expectedParts: 3 });
  });

  it('preserves the known composition on full receipt, then transfers and undoes just the frame', async () => {
    const f = fixture();
    for (const type of ['DOOR', 'DOOR', 'FRAME']) await f.scan(`${door}-${type}`, 'COLLECT');
    await f.service.receive({ ...request(), storeId: 1, items: [{ barcode: door, quantity: 3, version: 3 }] }, admin);
    const beforeTransfer = (await f.unit()).partTracking;
    const transfer = await f.service.transfer({
      ...request(), barcode: door, quantity: 1, parts: { FRAME: 1 }, version: 4, fromStoreId: 1, toStoreId: 2,
    }, admin);
    expect((await f.unit()).partTracking.stores).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, parts: expect.objectContaining({ DOOR: 2 }) }),
      expect.objectContaining({ id: 2, parts: expect.objectContaining({ FRAME: 1 }) }),
    ]));
    await f.service.undo(transfer.movement.id, request(), admin);
    expect((await f.unit()).partTracking).toEqual(beforeTransfer);
    expect(f.stocks[0]).toMatchObject({ expectedParts: 3, onHand: 3, inTransit: 0 });
  });

  it('asks for the composition of a partial mixed receipt instead of choosing a type', async () => {
    const f = fixture();
    await f.scan(`${door}-DOOR`, 'COLLECT');
    await f.scan(`${door}-FRAME`, 'COLLECT');
    const before = f.snapshot();
    await expect(f.service.receive({
      ...request(), storeId: 1, items: [{ barcode: door, quantity: 1, version: 2 }],
    }, admin)).rejects.toMatchObject({ response: { code: 'FACTORY_PART_QUANTITIES_REQUIRED' } });
    expect(f.snapshot()).toEqual(before);
    await f.service.receive({
      ...request(), storeId: 1, items: [{ barcode: door, quantity: 1, parts: { FRAME: 1 }, version: 2 }],
    }, admin);
    expect(await f.unit()).toMatchObject({
      partTracking: { inTransit: { DOOR: 1 }, onHand: { FRAME: 1 } },
    });
    expect((await f.unit()).partTracking.inTransit.FRAME ?? 0).toBe(0);
    expect((await f.unit()).partTracking.onHand.DOOR ?? 0).toBe(0);
  });

  it('keeps signed earlier deliveries unchanged when recording a typed delivery', async () => {
    const f = fixture();
    f.customerDeliveries.push({ id: 55, items: [{ barcode: `I${door}`, quantity: 1 }], signatureStrokes: signature });
    const original = structuredClone(f.customerDeliveries[0]);
    await f.scan(`${door}-FRAME`);
    await f.service.deliverToCustomer({
      ...request(), source: 'WAREHOUSE', storeId: 1, firstName: 'Maria', lastName: 'Recipient',
      signatureStrokes: signature, items: [{ barcode: door, quantity: 1, parts: { FRAME: 1 }, version: 1 }],
    }, admin);
    expect(f.customerDeliveries[0]).toEqual(original);
    expect(await f.unit()).toMatchObject({ onHand: 0, released: 1, partTracking: { released: { FRAME: 1 } } });
  });

  it('does not duplicate a typed reading on retry and rejects reuse for a different type', async () => {
    const f = fixture();
    const dto = { ...request(), barcode: `${door}-DOOR`, action: 'RECEIVE' as const, storeId: 1 };
    await f.service.scan(dto, admin);
    expect((await f.service.scan(dto, admin)).replayed).toBe(true);
    await expect(f.service.scan({ ...dto, barcode: `${door}-FRAME` }, admin)).rejects.toThrow();
    expect(f.movements).toHaveLength(1);
    expect(f.stocks[0].onHand).toBe(1);
  });

  it('recovers a pending old request without assigning a type or writing a second movement', async () => {
    const f = fixture(), dto = { ...request(), barcode: `I${door}`, action: 'RECEIVE' as const, storeId: 1 };
    f.stocks[0].onHand = 1;
    f.stocks[0].version = 1;
    f.balances.push({ lineNumber: door, storeId: 1, onHand: 1 });
    f.movements.push({
      id: 1, lineNumber: door, requestKey: dto.requestKey,
      requestHash: createHash('sha256').update(JSON.stringify([admin.id, 'RECEIVE', door, 1])).digest('hex'),
      type: 'RECEIVE', actorId: 1, quantity: 1, fromStoreId: null, toStoreId: 1,
      onHandDelta: 1, transitDelta: 0, releasedDelta: 0, onHandAfter: 1, transitAfter: 0, releasedAfter: 0,
      stockVersionAfter: 1, createdAt: new Date(), partDetails: null,
    });
    const before = f.snapshot();
    expect((await f.service.scan(dto, admin)).replayed).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });

  it('rolls back both typed and aggregate balances if audit recording fails', async () => {
    const f = fixture(), before = f.snapshot();
    f.db.warehouseMovement.create = async () => { throw new Error('Audit unavailable'); };
    await expect(f.scan(`${door}-FRAME`)).rejects.toThrow('Audit unavailable');
    expect(f.snapshot()).toEqual(before);
  });

  it('enforces the frame limit when two requests arrive concurrently', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.scan(`${door}-FRAME`), f.scan(`${door}-FRAME`)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.unit()).toMatchObject({ onHand: 1, partTracking: { onHand: { FRAME: 1 } } });
  });

  it('enforces the same limits inside a shared factory pickup', async () => {
    const f = fixture();
    const pickup = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    const read = (type: string) => f.service.factoryPickupScan(pickup.id, { ...request(), barcode: `${door}-${type}` }, tech);
    await read('DOOR');
    await read('DOOR');
    await expect(read('DOOR')).rejects.toThrow();
    expect(f.stocks[0].inTransit).toBe(2);
    await read('FRAME');
    expect(f.stocks[0]).toMatchObject({ inTransit: 3, expectedParts: 3 });
  });
});

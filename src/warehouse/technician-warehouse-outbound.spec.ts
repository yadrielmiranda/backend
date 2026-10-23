import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';
import { WarehouseCustomerDeliveryDto, WarehouseReleaseDto } from './warehouse.dto';

const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const colleague = { id: 4, role: { name: 'technician' as const } };
const door = '1029975', fixed = '1096240';
const signature = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];

function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  f.stocks[0].onHand = 3;
  f.balances.push({ lineNumber: door, storeId: 1, onHand: 3 });
  f.stocks[3].onHand = 1;
  f.balances.push({ lineNumber: fixed, storeId: 2, onHand: 1 });
  const release = (changes: Partial<WarehouseReleaseDto> = {}): WarehouseReleaseDto => ({
    requestKey: randomUUID(), storeId: 1, items: [{ barcode: door, quantity: 2, version: 0 }], ...changes,
  });
  const delivery = (changes: Partial<WarehouseCustomerDeliveryDto> = {}): WarehouseCustomerDeliveryDto => ({
    ...release(), source: 'WAREHOUSE', firstName: 'Maria', lastName: 'Recipient', signatureStrokes: signature, ...changes,
  });
  return { ...f, service, release, delivery };
}

describe('Technician warehouse outbound operations', () => {
  it('records an unsigned installation release under the authenticated technician and replays without another deduction', async () => {
    const f = fixture(), input = f.release();
    const result = await f.service.technicianRelease(input, tech);
    expect(result).toEqual({ units: 1, parts: 2, storeId: 1, storeName: 'Main', replayed: false });
    expect(f.movements).toMatchObject([{ actorId: 3, type: 'RELEASE', quantity: 2, onHandDelta: -2,
      fromStoreId: 1, customerDeliveryId: null, reason: 'Installation release from: Main' }]);
    expect(f.customerDeliveries).toHaveLength(0);
    expect(await f.service.technicianRelease(input, tech)).toEqual({ ...result, replayed: true });
    await expect(f.service.technicianRelease(input, colleague)).rejects.toThrow('another operation');
    expect(f.movements).toHaveLength(1);
    expect(f.stocks[0]).toMatchObject({ onHand: 1, released: 2 });
  });

  it('records a signed warehouse customer delivery without requiring a factory pickup and keeps its receipt private to the actor', async () => {
    const f = fixture(), input = f.delivery();
    const result = await f.service.technicianDeliverToCustomer(input, tech);
    expect(result).toMatchObject({ source: 'WAREHOUSE', storeId: 1, storeName: 'Main', actor: 'Technician Test', totalParts: 2 });
    expect(f.movements).toMatchObject([{ actorId: 3, fromStoreId: 1, customerDeliveryId: result.id, onHandDelta: -2, transitDelta: 0 }]);
    expect(await f.service.technicianCustomerDelivery(result.id, tech)).toMatchObject({ id: result.id, signatureStrokes: signature });
    await expect(f.service.technicianCustomerDelivery(result.id, colleague)).rejects.toThrow(NotFoundException);
    expect(await f.service.technicianDeliverToCustomer(input, tech)).toEqual({ ...result, replayed: true });
    expect(f.movements).toHaveLength(1);
  });

  it('supports explicitly unassigned warehouse stock through the same release process', async () => {
    const f = fixture(); f.balances.splice(0, 1); f.stocks[0].unassigned = 3;
    const result = await f.service.technicianRelease(f.release({ storeId: null }), tech);
    expect(result).toMatchObject({ storeId: null, storeName: 'Unassigned' });
    expect(f.stocks[0]).toMatchObject({ unassigned: 1, onHand: 1, released: 2 });
  });

  it('keeps count, version, store availability and commercial checks for unsigned and signed releases', async () => {
    for (const signed of [false, true]) for (const restriction of ['count', 'version', 'store', 'payment']) {
      const f = fixture();
      if (restriction === 'count') f.counts.push({ id: 1, activeSlot: 1 });
      if (restriction === 'version') f.stocks[0].version = 1;
      if (restriction === 'store') f.balances[0].storeId = 2;
      if (restriction === 'payment') f.order.payment.status = 'PENDING';
      await expect(signed ? f.service.technicianDeliverToCustomer(f.delivery(), tech)
        : f.service.technicianRelease(f.release(), tech)).rejects.toThrow();
      expect(f.movements).toHaveLength(0);
      expect(f.customerDeliveries).toHaveLength(0);
      expect(f.stocks[0]).toMatchObject({ onHand: 3, released: 0 });
    }
  });

  it('keeps DOOR and FRAME availability separate for technician barcode releases, including SIDELITE panel codes', async () => {
    const f = warehouseFixture(), service = new WarehouseService(f.db);
    for (const type of ['DOOR', 'SIDELITE', 'FRAME'])
      await service.technicianScan({ requestKey: randomUUID(), action: 'RECEIVE', barcode: `${door}-${type}`, storeId: 1 }, tech);
    for (const type of ['DOOR', 'SIDELITE'])
      await service.technicianScan({ requestKey: randomUUID(), action: 'RELEASE', barcode: `${door}-${type}`, storeId: 1 }, tech);
    await expect(service.technicianScan({ requestKey: randomUUID(), action: 'RELEASE', barcode: `${door}-DOOR`, storeId: 1 }, tech)).rejects.toThrow();
    expect(f.stocks[0]).toMatchObject({ onHand: 1, released: 2 });
    const result = await service.technicianScan({ requestKey: randomUUID(), action: 'RELEASE', barcode: `${door}-FRAME`, storeId: 1 }, tech);
    expect(result.movement.fromStore).toMatchObject({ id: 1, name: 'Main' });
    expect(f.movements.filter(m => m.type === 'RELEASE').every(m => m.actorId === tech.id)).toBe(true);
  });

  it('lists only stock at the selected store and forces on-hand inventory even if another view is requested', async () => {
    const f = fixture(); f.stocks[1].inTransit = 1;
    const result = await f.service.technicianWarehouseInventoryByPo({ storeId: '1', view: 'all' }, tech);
    expect(result).toMatchObject({ total: 1, activeCountId: null, summary: { onHand: 3 } });
    expect(result.items[0].units).toMatchObject([{ lineNumber: door, stores: [{ id: 1, onHand: 3 }] }]);
    expect(result.items[0].units).toHaveLength(1);
    const unit = await f.service.technicianWarehouseUnit(`${door}-FRAME`, tech);
    expect(unit).toMatchObject({ orderId: 1, customer: 'Pepe Test', project: 'Warehouse project' });
    for (const field of ['pieceId', 'price', 'payment']) expect(unit).not.toHaveProperty(field);
    await expect(f.service.technicianWarehouseUnit('1029967', tech)).rejects.toThrow(NotFoundException);
    for (const storeId of [undefined, 'all', '0', '-1', '1.1', '1abc'])
      await expect(f.service.technicianWarehouseInventoryByPo({ storeId }, tech)).rejects.toThrow('source store');
  });

  it('offers warehouse customer delivery quantities from the selected store', async () => {
    const f = fixture();
    const options = await f.service.technicianCustomerDeliveryOptions({ source: 'WAREHOUSE', storeId: '2' }, tech);
    expect(options).toMatchObject({ total: 1, countOpen: false,
      items: [{ availableParts: 1, customerName: 'Pepe Test', lines: [{ lineNumber: fixed }] }] });
    await expect(f.service.technicianCustomerDeliveryOptions({ source: 'WAREHOUSE', storeId: '1', pickupRunId: '1' }, tech)).rejects.toThrow('factory pickup');
    await expect(f.service.technicianDeliverToCustomer(f.delivery({ pickupRunId: 1 }), tech)).rejects.toThrow('factory pickup');
  });

  it('shows only this technician’s warehouse outbound history and ignores attempts to select another actor or movement type', async () => {
    const f = fixture();
    await f.service.technicianRelease(f.release({ items: [{ barcode: door, quantity: 1, version: 0 }] }), tech);
    await f.service.technicianRelease(f.release({ items: [{ barcode: door, quantity: 1, version: 1 }] }), colleague);
    await f.service.scan({ requestKey: randomUUID(), action: 'RECEIVE', barcode: '1029967-DOOR', storeId: 1 }, tech);
    const result = await f.service.technicianWarehouseHistory({ actorId: '4', type: 'RECEIVE' }, tech);
    expect(result).toMatchObject({ total: 1, items: [{ actorId: tech.id, type: 'RELEASE', lineNumber: door, quantity: 1 }] });
    expect(result.items).toHaveLength(1);
    const adminHistory = await f.service.history({}, admin);
    expect(adminHistory.total).toBe(3);
  });

  it.each(['admin', 'operator', 'dealer', 'client'] as const)('denies %s at every dedicated technician outbound boundary', async role => {
    const f = fixture(), actor = { id: 1, role: { name: role } };
    const calls = [
      () => f.service.technicianRelease(f.release(), actor),
      () => f.service.technicianWarehouseInventoryByPo({ storeId: '1' }, actor),
      () => f.service.technicianWarehouseUnit(door, actor),
      () => f.service.technicianWarehouseHistory({}, actor),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(ForbiddenException);
    expect(f.movements).toHaveLength(0);
  });
});

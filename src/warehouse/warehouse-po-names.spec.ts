import { randomUUID } from 'crypto';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const technician = { id: 3, role: { name: 'technician' as const } };
const door = '1029975';
const signature = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];

function fixture() {
  const f = warehouseFixture();
  f.externalPos.push({ id: 9, poNumber: 'EX900', orderId: null, orderName: 'Fernando Vaca', supplierName: 'ECO' });
  f.stocks.push({ ...f.stocks[3], lineNumber: '880001', pieceId: null, externalPoId: 9, description: 'External window', panels: 1 });
  return { ...f, service: new WarehouseService(f.db) };
}

describe('Warehouse PO display names', () => {
  it('uses the same customer/project priority as inventory without deriving a name from the PO number', async () => {
    const f = fixture();
    const inventory = await f.service.inventoryByPo({ view: 'all' }, admin);
    for (const group of inventory.items) {
      expect(group.poName).toBe(group.customer || group.project);
      for (const unit of group.units) expect(unit.poName).toBe(group.poName);
    }
    expect(await f.service.unit(door, admin)).toMatchObject({ poNumber: '281374', poName: 'Pepe Test' });
    expect(await f.service.unit('880001', admin)).toMatchObject({ poNumber: 'EX900', poName: 'Fernando Vaca' });
    f.pieces[0].estim.customerFirstName = ''; f.pieces[0].estim.customerLastName = '';
    expect(await f.service.unit(door, admin)).toMatchObject({ poName: 'Admin Test' });
    f.users[0].firstName = ''; f.users[0].lastName = '';
    expect(await f.service.unit(door, admin)).toMatchObject({ poName: 'Warehouse project' });
    f.externalPos[0].orderName = null;
    expect(await f.service.unit('880001', admin)).toMatchObject({ poName: '' });
  });

  it('keeps names on pickup previews, all PO headers, technician scans and replay without exposing customer records', async () => {
    const f = fixture();
    expect(await f.service.factoryPickupPo('281374', admin)).toMatchObject({ poName: 'Pepe Test' });
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374', 'EX900'], technicianIds: [3] }, admin);
    for (const actor of [admin, technician]) {
      const pickup = await f.service.factoryPickup(run.id, actor);
      expect(pickup.orders).toEqual(expect.arrayContaining([
        expect.objectContaining({ poNumber: '281374', poName: 'Pepe Test' }),
        expect.objectContaining({ poNumber: 'EX900', poName: 'Fernando Vaca' }),
      ]));
      for (const line of pickup.lines) {
        expect(line.poName).toBe(line.source === 'ORDER' ? 'Pepe Test' : 'Fernando Vaca');
        for (const field of ['customer', 'project', 'user', 'estimate', 'price', 'rate', 'markup'])
          expect(line).not.toHaveProperty(field);
      }
    }
    const dto = { barcode: `${door}-DOOR`, requestKey: randomUUID() };
    for (const result of [await f.service.factoryPickupScan(run.id, dto, technician), await f.service.factoryPickupScan(run.id, dto, technician)]) {
      if (result.kind !== 'COLLECTED') throw new Error('Expected collected scan');
      expect(result.stock.poName).toBe('Pepe Test');
    }
    const history = await f.service.history({}, admin);
    expect(history.items[0]).toMatchObject({ source: 'ORDER', poNumber: '281374', orderNumber: '1001', poName: 'Pepe Test' });
    expect(f.movements).toHaveLength(1);
  });

  it('saves PO names with the signed delivery and preserves them when the current customer is renamed', async () => {
    const f = fixture(); f.stocks[0].inTransit = 3;
    const result = await f.service.deliverToCustomer({
      requestKey: randomUUID(), source: 'TRANSIT', firstName: 'Maria', lastName: 'Recipient',
      signatureStrokes: signature, items: [{ barcode: door, quantity: 1, version: 0 }],
    }, admin);
    expect(result.items).toMatchObject([{ poNumber: '281374', poName: 'Pepe Test', quantity: 1 }]);
    f.pieces[0].estim.customerFirstName = 'Renamed';
    expect((await f.service.customerDelivery(result.id, admin)).items).toEqual(result.items);
    expect((await f.service.history({}, admin)).items[0]).toMatchObject({ poName: 'Renamed Test', type: 'RELEASE' });
  });

  it('enriches legacy receipts read-only and does not attach a name from a line now belonging to a different PO', async () => {
    const f = fixture();
    const receipt = await f.db.warehouseCustomerDelivery.create({ data: {
      source: 'TRANSIT', actorId: 3, actorName: 'Technician Test', firstName: 'Maria', lastName: 'Recipient',
      signatureStrokes: signature, totalPieces: 4, totalParts: 4,
      items: [
        { source: 'ORDER', orderNumber: '1001', poNumber: '281374', lineNumber: door, quantity: 1 },
        { source: 'EXTERNAL', orderNumber: '', poNumber: 'EX900', lineNumber: '880001', quantity: 1 },
        { source: 'ORDER', orderNumber: '9999', poNumber: 'OLDPO', lineNumber: door, quantity: 1 },
        { source: 'ORDER', orderNumber: '9999', poNumber: '281374', lineNumber: door, quantity: 1 },
      ],
    } });
    const stored = structuredClone(f.customerDeliveries);
    const result = await f.service.technicianCustomerDelivery(receipt.id, technician);
    expect(result.items).toMatchObject([{ poName: 'Pepe Test' }, { poName: 'Fernando Vaca' }, { poName: '' }, { poName: '' }]);
    expect(f.customerDeliveries).toEqual(stored);
    expect(result.signatureStrokes).toEqual(signature);
    expect(result.totalParts).toBe(4);
  });

  it('enriches closed delivery PO headers and pending pieces without changing the signed snapshot', async () => {
    const f = fixture();
    const snapshot = {
      items: [{ source: 'EXTERNAL', poNumber: 'EX900', lineNumber: '880001', quantity: 1 }],
      pendingItems: [{ source: 'ORDER', poNumber: '281374', orderNumber: '1001', lineNumber: door, quantity: 2 }],
      orders: [{ key: 'external:9', source: 'EXTERNAL', poNumber: 'EX900' },
        { key: 'order:1', source: 'ORDER', poNumber: '281374', orderNumber: '1001' }],
    };
    const original = structuredClone(snapshot);
    const result = await (f.service as any).deliveryRunView(f.db, { status: 'CLOSED', snapshot, deliveryId: null, storeId: 1, storeName: 'Main' });
    expect(result.items[0].poName).toBe('Fernando Vaca');
    expect(result.allocations[0].poName).toBe('Fernando Vaca');
    expect(result.pendingItems[0].poName).toBe('Pepe Test');
    expect(result.orders.map((row: { poName: string }) => row.poName)).toEqual(['Fernando Vaca', 'Pepe Test']);
    expect(snapshot).toEqual(original);
  });
});

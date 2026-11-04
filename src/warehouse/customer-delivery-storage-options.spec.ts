import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';

const admin = { id: 1, role: { name: 'admin' as const } };
const technician = { id: 3, role: { name: 'technician' as const } };

function fixture() {
  const f = warehouseFixture();
  const source = { key: 'order:1', source: 'ORDER', orderId: 1, externalPoId: null, orderNumber: f.order.number, poNumber: f.order.poNumber };
  const run: any = {
    id: 1, status: 'ACTIVE', multiStore: true, version: 0,
    storeId: null, storeName: '', orders: [source], items: [],
    deliveryId: null, snapshot: null, closedAt: null,
    createdById: 1, createdByName: 'Admin Test', createdAt: new Date(), updatedAt: new Date(),
  };
  f.db.warehouseCustomerDeliveryRun = { findUnique: async () => structuredClone(run) };
  f.db.warehouseCustomerDeliveryRunEvent = { findFirst: async () => null };
  const service = new WarehouseService(f.db);
  const available = async (actor = admin) => (await service.customerDeliveryRun(1, actor)).availableStorages;
  return { ...f, run, service, available };
}

describe('storage options for the POs in a customer delivery', () => {
  it('includes each stocked location once across pieces and sorts by name', async () => {
    const f = fixture();
    f.stores[0].name = 'Zulu'; f.stores[1].name = 'Alpha';
    f.stocks[0].onHand = 3; f.stocks[1].onHand = 1;
    f.balances.push(
      { lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 2 },
      { lineNumber: f.stocks[0].lineNumber, storeId: 2, onHand: 1 },
      { lineNumber: f.stocks[1].lineNumber, storeId: 1, onHand: 1 },
    );
    expect(await f.available()).toEqual([
      { storeId: 2, storeName: 'Alpha' }, { storeId: 1, storeName: 'Zulu' },
    ]);
  });

  it('excludes locations containing only another PO, even with the same PO number', async () => {
    const f = fixture();
    f.externalPos.push({ id: 1, poNumber: f.order.poNumber, orderName: 'External', supplierName: 'Factory' });
    Object.assign(f.stocks[3], { pieceId: null, externalPoId: 1, onHand: 1 });
    f.stocks[0].onHand = 1;
    f.balances.push(
      { lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 },
      { lineNumber: f.stocks[3].lineNumber, storeId: 2, onHand: 1 },
    );
    expect(await f.available()).toEqual([{ storeId: 1, storeName: 'Main' }]);
    f.run.orders = [{ key: 'external:1', source: 'EXTERNAL', orderId: null, externalPoId: 1, orderNumber: '', poNumber: f.order.poNumber }];
    expect(await f.available()).toEqual([{ storeId: 2, storeName: 'Overflow' }]);
  });

  it('excludes empty and inactive stores and parts that are only in transit', async () => {
    const f = fixture();
    f.stocks[0].onHand = 1; f.stocks[1].inTransit = 2;
    f.stores[0].isActive = false;
    f.balances.push(
      { lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 },
      { lineNumber: f.stocks[0].lineNumber, storeId: 2, onHand: 0 },
    );
    expect(await f.available()).toEqual([]);
  });

  it('offers Unassigned only while the selected POs have unassigned stock', async () => {
    const f = fixture();
    expect(await f.available()).toEqual([]);
    Object.assign(f.stocks[0], { onHand: 2, unassigned: 1 });
    f.balances.push({ lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 });
    expect(await f.available()).toEqual([
      { storeId: 1, storeName: 'Main' }, { storeId: null, storeName: 'Unassigned' },
    ]);
    f.stocks[0].unassigned = 0; f.stocks[0].onHand = 1;
    expect(await f.available()).toEqual([{ storeId: 1, storeName: 'Main' }]);
  });

  it('returns no locations before adding any POs', async () => {
    const f = fixture();
    f.run.orders = [];
    Object.assign(f.stocks[0], { onHand: 2, unassigned: 1 });
    f.balances.push({ lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 });
    expect(await f.available()).toEqual([]);
  });

  it('keeps a physical source available after its parts are recorded but before closing', async () => {
    const f = fixture();
    f.stocks[0].onHand = 1;
    f.balances.push({ lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 });
    f.run.items = [{ lineNumber: f.stocks[0].lineNumber, quantity: 1, parts: { DOOR: 1 }, storeId: 1, storeName: 'Main' }];
    expect(await f.available()).toEqual([{ storeId: 1, storeName: 'Main' }]);
  });

  it('returns the same scoped choices to an administrator and a technician', async () => {
    const f = fixture();
    f.stocks[0].onHand = 1;
    f.balances.push({ lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 1 });
    const administratorView = await f.service.customerDeliveryRun(1, admin);
    const technicianView = await f.service.customerDeliveryRun(1, technician);
    expect(technicianView.availableStorages).toEqual(administratorView.availableStorages);
    expect(technicianView.availableStorages).toEqual([{ storeId: 1, storeName: 'Main' }]);
  });

  it('does not expose stale storage options from a closed delivery snapshot', async () => {
    const f = fixture();
    f.run.status = 'CLOSED';
    f.run.snapshot = { id: 1, orders: [], items: [], availableStorages: [{ storeId: 1, storeName: 'Main' }] };
    expect(await f.available()).toEqual([]);
  });
});

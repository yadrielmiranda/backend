import { randomUUID } from 'crypto';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { assertScheduleMilestone } from '../payment-plans/payment-schedule';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';

jest.mock('../payment-plans/payment-schedule', () => ({ assertScheduleMilestone: jest.fn() }));
const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const request = () => ({ requestKey: randomUUID() });

function fixture() {
  const f = warehouseFixture();
  const notifications = { createAndSend: jest.fn() };
  f.db.orderStatus = { findUnique: async () => ({ id: 9, name: 'Picked up' }) };
  f.db.order.update = jest.fn(async ({ data }) => {
    Object.assign(f.order, data);
    if (data.statusId === 9) f.order.status.name = 'Picked up';
    return structuredClone(f.order);
  });
  return {
    ...f, notifications,
    warehouse: new WarehouseService(f.db),
    deliveries: new DeliveriesService(f.db, null as any, null as any, notifications as any, { log: jest.fn() } as any, null as any),
  };
}

describe('Internal collection and direct customer factory pickup', () => {
  beforeEach(() => jest.mocked(assertScheduleMilestone).mockReset());

  it('collects and receives unpaid material without changing the order or notifying its owner', async () => {
    const f = fixture();
    f.order.status.name = 'Awaiting release';
    f.order.payment.status = 'PENDING';
    jest.mocked(assertScheduleMilestone).mockRejectedValue(new Error('Release unpaid'));
    const pickup = await f.warehouse.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    await f.warehouse.factoryPickupScan(pickup.id, { ...request(), barcode: '1096240' }, tech);
    await f.warehouse.receive({ ...request(), storeId: 2, items: [
      { barcode: '1096240', quantity: 1, version: f.stocks[3].version },
    ] }, tech);
    expect(f.stocks[3]).toMatchObject({ onHand: 1, inTransit: 0, released: 0 });
    expect(f.order.status.name).toBe('Awaiting release');
    expect(assertScheduleMilestone).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it('records customer factory fulfillment without a fictitious store receipt and prevents recollection', async () => {
    const f = fixture();
    f.order.fulfillmentMethod = 'FACTORY_PICKUP';
    await f.deliveries.completePickup(f.order.id, admin);
    expect(assertScheduleMilestone).toHaveBeenCalledWith(f.db, f.order.idEst, 'RELEASE');
    expect(f.order.status.name).toBe('Picked up');
    expect(f.stocks.every(s => s.released === s.expectedParts && s.inTransit === 0 && s.onHand === 0)).toBe(true);
    expect(f.balances).toHaveLength(0);
    expect(f.movements).toHaveLength(4);
    expect(f.movements.every(m => m.type === 'FACTORY_RELEASE' && m.actorId === admin.id)).toBe(true);
    await expect(f.warehouse.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin)).rejects.toThrow('direct factory pickup');
    await expect(f.warehouse.scan({ ...request(), barcode: '1096240', action: 'COLLECT' }, admin)).rejects.toThrow('direct factory pickup');
  });

  it('still requires Release payment for direct customer pickup', async () => {
    const f = fixture(); f.order.fulfillmentMethod = 'FACTORY_PICKUP';
    jest.mocked(assertScheduleMilestone).mockRejectedValue(new Error('Release unpaid'));
    await expect(f.deliveries.completePickup(f.order.id, admin)).rejects.toThrow('Release unpaid');
    expect(f.movements).toHaveLength(0);
    expect(f.db.order.update).not.toHaveBeenCalled();
  });

  it('does not change warehouse stock when completing ordinary customer pickup', async () => {
    const f = fixture(), before = structuredClone(f.stocks);
    await f.deliveries.completePickup(f.order.id, admin);
    expect(f.stocks).toEqual(before);
    expect(f.movements).toHaveLength(0);
  });

  it.each(['run', 'inTransit', 'onHand', 'released', 'count', 'unknownParts'])(
    'rejects inconsistent direct pickup atomically: %s', async (conflict) => {
      const f = fixture();
      if (conflict === 'run') await f.warehouse.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
      else if (conflict === 'count') await f.warehouse.startCount({ ...request(), scope: 'ALL' }, admin);
      else if (conflict === 'unknownParts') f.stocks[3].expectedParts = null;
      else f.stocks[0][conflict] = 1;
      f.order.fulfillmentMethod = 'FACTORY_PICKUP';
      const before = structuredClone(f.stocks);
      await expect(f.deliveries.completePickup(f.order.id, admin)).rejects.toThrow();
      expect(f.stocks).toEqual(before);
      expect(f.movements).toHaveLength(0);
      expect(f.db.order.update).not.toHaveBeenCalled();
      expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    },
  );
});

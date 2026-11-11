import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { WarehouseService } from './warehouse.service';
import { warehouseFixture } from '../../test/warehouse-fixture';

const admin = { id: 1, role: { name: 'admin' as const } };
const technician = { id: 3, role: { name: 'technician' as const } };
const door = '1029975';
function fixture() {
  const f = warehouseFixture();
  return { ...f, service: new WarehouseService(f.db) };
}

describe('Warehouse piece dimensions', () => {
  it('reads stored decimal dimensions without rounding, deriving missing sizes, or exposing piece prices', async () => {
    const f = fixture();
    const stock = await f.db.warehouseStock.findUnique({ where: { lineNumber: door } });
    Object.assign(stock.unit.piece, {
      width: new Prisma.Decimal('97.625'), height: new Prisma.Decimal('82.125'),
      doorWidth: new Prisma.Decimal('72.375'), leftSideliteWidth: null,
      rate: '999.99', price: '1200', markup: '0.2',
    });
    const read = jest.spyOn(f.db.warehouseStock, 'findUnique').mockResolvedValue(stock);
    const unit = await f.service.unit(door, admin);
    expect(unit.dimensions).toMatchObject({
      width: '97.625', height: '82.125', doorWidth: '72.375',
      leftSideliteWidth: null, rightSideliteWidth: null,
    });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ unit: expect.objectContaining({
        include: expect.objectContaining({ piece: expect.objectContaining({
          select: expect.objectContaining({ width: true, height: true, doorWidth: true }),
        }) }),
      }) }),
    }));
    for (const field of ['rate', 'price', 'markup', 'piece']) expect(unit).not.toHaveProperty(field);
  });

  it('keeps dimensions in admin and technician pickup lines, scan results and retry responses', async () => {
    const f = fixture();
    Object.assign(f.pieces[0], { width: '100.125', height: '96', doorWidth: '72.25', doorHeight: '80',
      leftSideliteWidth: '13.875', rightSideliteWidth: null });
    Object.assign(f.pieces[3], { width: '48.375', height: null, heightLeft: '60.125', heightRight: '72.5',
      legHeight: '36', sashHeight: '20.625', windowHeight: '50.75' });
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    for (const actor of [admin, technician]) {
      const pickup = await f.service.factoryPickup(run.id, actor);
      expect(pickup.lines.find(line => line.lineNumber === door)?.dimensions).toMatchObject({
        width: '100.125', height: '96', doorWidth: '72.25', doorHeight: '80',
        leftSideliteWidth: '13.875', rightSideliteWidth: null,
      });
      expect(pickup.lines.find(line => line.lineNumber === '1096240')?.dimensions).toMatchObject({
        width: '48.375', height: null, heightLeft: '60.125', heightRight: '72.5',
        legHeight: '36', sashHeight: '20.625', windowHeight: '50.75',
      });
      for (const line of pickup.lines)
        for (const field of ['customer', 'project', 'pieceId', 'price', 'rate', 'markup'])
          expect(line).not.toHaveProperty(field);
    }
    const scan = { barcode: `${door}-DOOR`, requestKey: randomUUID() };
    for (const result of [await f.service.factoryPickupScan(run.id, scan, technician),
      await f.service.factoryPickupScan(run.id, scan, technician)]) {
      if (result.kind !== 'COLLECTED') throw new Error('Expected collected scan');
      expect(result.stock.dimensions).toEqual(run.lines.find(line => line.lineNumber === door)?.dimensions);
      expect(result.pickup.lines.find(line => line.lineNumber === door)?.dimensions).toEqual(result.stock.dimensions);
    }
    expect(f.movements).toHaveLength(1);
  });

  it('includes dimensions when confirming an unplanned PO without collecting it', async () => {
    const f = fixture();
    const otherOrder = { ...f.order, id: 2, number: '1002', poNumber: '293600' };
    f.orders.push(otherOrder);
    f.pieces[0].estim.order = otherOrder;
    Object.assign(f.pieces[0], { width: '74.875', height: '82.25' });
    const run = await f.service.startFactoryPickup({ poNumbers: ['281374'], technicianIds: [3] }, admin);
    const result = await f.service.factoryPickupScan(run.id,
      { barcode: `${door}-DOOR`, requestKey: randomUUID() }, technician);
    if (result.kind !== 'PO_NOT_INCLUDED') throw new Error('Expected unplanned PO');
    expect(result.candidate.dimensions).toMatchObject({ width: '74.875', height: '82.25' });
    expect(f.movements).toHaveLength(0);
  });

  it('preserves external factory descriptions and leaves absent measurements empty', async () => {
    const f = fixture();
    const internal = await f.service.unit(door, admin);
    expect(Object.values(internal.dimensions!)).toEqual(expect.arrayContaining([null]));
    expect(Object.values(internal.dimensions!).every(value => value === null)).toBe(true);
    f.externalPos.push({ id: 1, poNumber: 'EX100', orderId: null, orderName: 'External', supplierName: 'ECO' });
    const description = 'French Door\nSize: 39 x 82\nWhite';
    f.stocks.push({ ...f.stocks[0], lineNumber: '880001', pieceId: null, externalPoId: 1, description, panels: 2 });
    const run = await f.service.startFactoryPickup({ poNumbers: ['EX100'], technicianIds: [3] }, admin);
    expect(run.lines[0]).toMatchObject({ dimensions: null, description });
    expect((await f.service.factoryPickup(run.id, technician)).lines[0]).toMatchObject({ dimensions: null, description });
  });
});

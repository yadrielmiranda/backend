import { randomUUID } from 'crypto';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';

const admin = { id: 1, role: { name: 'admin' as const } };

function fixture() {
  const f = warehouseFixture();
  for (const stock of f.stocks) stock.inTransit = 1;
  return { ...f, service: new WarehouseService(f.db) };
}

describe('whole PO choices for warehouse receipts and customer delivery', () => {
  it('uses a matching barcode to show every available piece in that PO', async () => {
    const f = fixture();
    f.stocks[3].inTransit = 0;
    const result = await f.service.inventoryByPo({ view: 'in_transit', search: '1029975', completePo: 'true' }, admin);
    expect(result.total).toBe(1);
    expect(result.items[0].units.map(unit => unit.lineNumber)).toEqual(['1029967', '1029968', '1029975']);
    expect(result.summary.inTransit).toBe(3);
  });

  it('preserves the existing piece search when whole PO mode is not requested', async () => {
    const f = fixture();
    const result = await f.service.inventoryByPo({ view: 'in_transit', search: '1029975' }, admin);
    expect(result.items[0].units.map(unit => unit.lineNumber)).toEqual(['1029975']);
    expect(result.summary.inTransit).toBe(1);
  });

  it('keeps warehouse choices inside the selected store', async () => {
    const f = fixture();
    f.stocks[0].onHand = 2; f.stocks[1].onHand = 1; f.stocks[2].onHand = 1;
    f.balances.push(
      { lineNumber: f.stocks[0].lineNumber, storeId: 1, onHand: 2 },
      { lineNumber: f.stocks[1].lineNumber, storeId: 1, onHand: 1 },
      { lineNumber: f.stocks[2].lineNumber, storeId: 2, onHand: 1 },
    );
    const result = await f.service.inventoryByPo({ view: 'on_hand', storeId: '1', search: '1029975', completePo: 'true' }, admin);
    expect(result.items[0].units.map(unit => unit.lineNumber)).toEqual(['1029967', '1029975']);
    expect(result.summary.onHand).toBe(3);
  });

  it('does not merge internal and external sources that share a PO number or numeric ID', async () => {
    const f = fixture();
    f.externalPos.push({ id: 1, poNumber: f.order.poNumber, orderName: 'External job', supplierName: 'Factory' });
    Object.assign(f.stocks[3], { pieceId: null, externalPoId: 1, description: 'Separate external piece' });
    const result = await f.service.inventoryByPo({ view: 'in_transit', search: '1029975', completePo: 'true' }, admin);
    expect(result.items.map(group => group.key)).toEqual(['order:1']);
    expect(result.items[0].units).toHaveLength(3);
    const external = await f.service.inventoryByPo({ view: 'in_transit', search: '1096240', completePo: 'true' }, admin);
    expect(external.items.map(group => group.key)).toEqual(['external:1']);
    expect(external.items[0].units.map(unit => unit.lineNumber)).toEqual(['1096240']);
  });

  it('paginates POs without splitting their pieces', async () => {
    const f = fixture();
    f.pieces[3].estim.order = { ...f.order, id: 2, number: '1002', poNumber: '381922' };
    const query = { view: 'in_transit', search: 'Warehouse project', completePo: 'true', pageSize: '1' };
    const first = await f.service.inventoryByPo({ ...query, page: '1' }, admin);
    const second = await f.service.inventoryByPo({ ...query, page: '2' }, admin);
    expect(first.total).toBe(2);
    expect(first.items[0].units).toHaveLength(3);
    expect(second.items[0].units.map(unit => unit.lineNumber)).toEqual(['1096240']);
  });

  it('returns no unrelated POs or quantities when the search has no match', async () => {
    const f = fixture();
    const result = await f.service.inventoryByPo({ view: 'in_transit', search: 'missing-po', completePo: 'true' }, admin);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.summary.inTransit).toBe(0);
  });

  it('keeps the remainder selectable after splitting a PO between two stores', async () => {
    const f = fixture();
    f.stocks[0].inTransit = 3; f.stocks[1].inTransit = 0;
    const initial = await f.service.inventoryByPo({ view: 'in_transit', completePo: 'true' }, admin);
    expect(initial.items[0].units).toHaveLength(3);
    await f.service.receive({ storeId: 1, requestKey: randomUUID(), items: [
      { barcode: 'I1029975', quantity: 2, version: 0 },
      { barcode: 'I1029968', quantity: 1, version: 0 },
    ] }, admin);
    const remaining = await f.service.inventoryByPo({ view: 'in_transit', completePo: 'true' }, admin);
    expect(remaining.items[0].units.map(unit => [unit.lineNumber, unit.inTransit])).toEqual([
      ['1029975', 1], ['1096240', 1],
    ]);
    await f.service.receive({ storeId: 2, requestKey: randomUUID(), items: remaining.items[0].units.map(unit => ({
      barcode: unit.barcode, quantity: unit.inTransit, version: unit.version,
    })) }, admin);
    expect((await f.service.inventoryByPo({ view: 'in_transit', completePo: 'true' }, admin)).items).toEqual([]);
    expect(f.balances.filter(row => row.storeId === 1).reduce((sum, row) => sum + row.onHand, 0)).toBe(3);
    expect(f.balances.filter(row => row.storeId === 2).reduce((sum, row) => sum + row.onHand, 0)).toBe(2);
    expect(f.stocks.reduce((sum, row) => sum + row.onHand, 0)).toBe(5);
  });
});

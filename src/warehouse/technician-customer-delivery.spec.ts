import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { warehouseFixture } from '../../test/warehouse-fixture';
import { WarehouseService } from './warehouse.service';
import { WarehouseCustomerDeliveryDto } from './warehouse.dto';
import type { AuthUser } from '@/auth/types/auth-user.type';

const admin = { id: 1, role: { name: 'admin' as const } };
const tech = { id: 3, role: { name: 'technician' as const } };
const colleague = { id: 4, role: { name: 'technician' as const } };
const stranger = { id: 6, role: { name: 'technician' as const } };
const door = '1029975', slider = '1029967', fixed = '1096240';
const signature = () => [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.5, y: 0.1 }]];
const partial = { cycle: 0, partialReason: 'NOT_READY_AT_FACTORY' as const, note: 'Other parts still in production' };

function fixture() {
  const f = warehouseFixture(), service = new WarehouseService(f.db);
  const start = (technicianIds = [3, 4], poNumbers = ['281374']) => service.startFactoryPickup({ technicianIds, poNumbers }, admin);
  const collect = (id: number, barcode = door, actor: AuthUser = tech) => {
    const current = f.stocks.find(stock => stock.lineNumber === barcode);
    const partType = [door, slider].includes(barcode)
      ? current.inTransit + current.onHand + current.released < current.expectedParts - 1 ? 'DOOR' as const : 'FRAME' as const
      : 'WINDOW' as const;
    return service.factoryPickupScan(id, { barcode, partType, requestKey: randomUUID() }, actor);
  };
  const dto = (items?: WarehouseCustomerDeliveryDto['items']): WarehouseCustomerDeliveryDto => ({
    requestKey: randomUUID(), source: 'TRANSIT', firstName: 'Maria', lastName: 'Recipient', signatureStrokes: signature(),
    items: items ?? f.stocks.filter((s) => s.inTransit > 0).map((s) => ({ barcode: `I${s.lineNumber}`, quantity: s.inTransit, version: s.version })),
  });
  const options = (actor: AuthUser = tech, query = {}) => service.technicianCustomerDeliveryOptions(query, actor);
  const deliver = (input = dto(), actor: AuthUser = tech) => service.technicianDeliverToCustomer(input, actor);
  const snapshot = () => structuredClone({ stocks: f.stocks, movements: f.movements, deliveries: f.customerDeliveries });
  return { ...f, service, start, collect, dto, options, deliver, snapshot };
}

describe('Technician customer handoffs from assigned factory pickups', () => {
  it('lists a complete selectable PO with all collected lines and the full expected total', async () => {
    const f = fixture(), run = await f.start();
    await f.collect(run.id, door); await f.collect(run.id, door, colleague); await f.collect(run.id, fixed);
    const options = await f.options();
    expect(options).toMatchObject({ total: 1, page: 1, pageSize: 50, countOpen: false });
    expect(options.items[0]).toMatchObject({ key: 'order:1', poNumber: '281374', orderNumber: '1001',
      customerName: 'Pepe Test', projectName: 'Warehouse project', expectedParts: 9, availableParts: 3, pieces: 2 });
    expect(options.items[0].lines).toMatchObject([{ lineNumber: door, inTransit: 2, version: 2 }, { lineNumber: fixed, inTransit: 1, version: 1 }]);
    expect(options.items[0].lines[0]).not.toHaveProperty('price');
    expect(await f.options(colleague)).toEqual(options);
    expect((await f.options(stranger)).items).toEqual([]);
  });

  it('shows nothing before any scan, and does not expose legacy stock without assigned collection evidence', async () => {
    const f = fixture(); await f.start();
    expect((await f.options()).items).toEqual([]);
    f.stocks[0].inTransit = 1;
    expect((await f.options()).items).toEqual([]);
    await expect(f.deliver()).rejects.toThrow(ForbiddenException);
  });

  it('delivers a whole selected PO with one signed receipt and no new scan or warehouse receipt', async () => {
    const f = fixture(), run = await f.start();
    await f.collect(run.id); await f.collect(run.id, fixed);
    const result = await f.deliver();
    expect(result).toMatchObject({ source: 'TRANSIT', totalPieces: 2, totalParts: 2, firstName: 'Maria', lastName: 'Recipient', actor: 'Technician Test' });
    expect(result.items).toMatchObject([{ lineNumber: door, quantity: 1, poNumber: '281374' }, { lineNumber: fixed, quantity: 1, poNumber: '281374' }]);
    expect(f.movements.filter((m) => m.type === 'RELEASE')).toMatchObject([
      { pickupRunId: run.id, quantity: 1, transitDelta: -1, customerDeliveryId: result.id },
      { pickupRunId: run.id, quantity: 1, transitDelta: -1, customerDeliveryId: result.id },
    ]);
    expect(f.stocks.reduce((sum, s) => sum + s.inTransit + s.onHand, 0)).toBe(0);
    expect(f.movements.some((m) => m.type === 'RECEIVE')).toBe(false);
    expect((await f.options()).items).toEqual([]);
    expect(await f.service.technicianCustomerDelivery(result.id, tech)).toMatchObject({ id: result.id, signatureStrokes: signature() });
  });

  it('keeps scanned quantities available after finishing a partial pickup', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id);
    await f.service.finishFactoryPickup(run.id, partial, tech);
    expect((await f.options()).items[0].availableParts).toBe(1);
    expect(await f.deliver()).toMatchObject({ totalParts: 1 });
  });

  it('supports external POs without a commercial customer account', async () => {
    const f = fixture();
    f.externalPos.push({ id: 8, orderId: null, poNumber: '292427', orderName: 'Santos', supplierName: 'Factory' });
    Object.assign(f.stocks[3], { pieceId: null, externalPoId: 8, description: 'External window' });
    const run = await f.start([3], ['292427']); await f.collect(run.id, fixed);
    expect((await f.options()).items[0]).toMatchObject({ key: 'external:8', projectName: 'Santos', expectedParts: 1 });
    expect(await f.deliver()).toMatchObject({ totalParts: 1, items: [{ source: 'EXTERNAL', poNumber: '292427' }] });
  });

  it('matches visible PO descriptions but always returns every eligible line in the matching PO', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id); await f.collect(run.id, fixed);
    expect((await f.options(tech, { search: 'French Door' })).items[0].lines).toHaveLength(2);
    expect((await f.options(tech, { search: 'Pepe' })).total).toBe(1);
    expect((await f.options(tech, { poKey: 'order:1' })).total).toBe(1);
    expect((await f.options(tech, { poKey: 'external:1' })).total).toBe(0);
    expect((await f.options(tech, { search: 'unknown' })).items).toEqual([]);
    await expect(f.options(tech, { poKey: 'order:0' })).rejects.toThrow('valid PO');
    await expect(f.options(tech, { pageSize: '101' })).rejects.toThrow('Invalid page');
  });

  it('paginates POs instead of truncating their lines', async () => {
    const f = fixture();
    const order = { ...f.order, id: 2, number: '1002', poNumber: '293600' };
    f.orders.push(order); f.pieces[1].estim.order = order;
    const run = await f.start([3], ['281374', '293600']);
    await f.collect(run.id); await f.collect(run.id, fixed); await f.collect(run.id, slider);
    expect(await f.options(tech, { page: '1', pageSize: '1' })).toMatchObject({ total: 2, items: [{ poNumber: '281374', pieces: 2 }] });
    expect(await f.options(tech, { page: '2', pageSize: '1' })).toMatchObject({ total: 2, items: [{ poNumber: '293600', pieces: 1 }] });
  });

  it('does not let unassigned technicians submit another crew’s PO or view their signature', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id);
    const input = f.dto(), before = f.snapshot();
    await expect(f.deliver(input, stranger)).rejects.toThrow(ForbiddenException);
    expect(f.snapshot()).toEqual(before);
    const receipt = await f.deliver(input);
    for (const actor of [colleague, stranger])
      await expect(f.service.technicianCustomerDelivery(receipt.id, actor)).rejects.toThrow(NotFoundException);
    expect(await f.service.customerDelivery(receipt.id, admin)).toMatchObject({ id: receipt.id });
  });

  it('rechecks pickup assignments at submission rather than trusting a previously viewed PO', async () => {
    const f = fixture(), run = await f.start([3]); await f.collect(run.id);
    const input = f.dto(); expect((await f.options()).total).toBe(1);
    await f.service.assignFactoryPickup(run.id, { technicianIds: [4] }, admin);
    await expect(f.deliver(input)).rejects.toThrow(ForbiddenException);
    expect(await f.deliver(input, colleague)).toMatchObject({ totalParts: 1 });
  });

  it('returns the original receipt on retry even after stock or assignment is gone', async () => {
    const f = fixture(), run = await f.start([3]); await f.collect(run.id);
    const input = f.dto(), receipt = await f.deliver(input), before = f.snapshot();
    await f.service.assignFactoryPickup(run.id, { technicianIds: [4] }, admin);
    expect(await f.deliver(input)).toEqual({ ...receipt, replayed: true });
    expect(f.snapshot()).toEqual(before);
    await expect(f.deliver(input, colleague)).rejects.toThrow('another operation');
  });

  it('keeps administrative entrypoints unavailable to technicians and dedicated routes unavailable to other roles', async () => {
    const f = fixture();
    await expect(f.service.deliverToCustomer(f.dto(), tech)).rejects.toThrow(ForbiddenException);
    await expect(f.service.customerDelivery(1, tech)).rejects.toThrow(ForbiddenException);
    for (const role of ['admin', 'operator', 'client', 'dealer'] as const) {
      const actor = { id: 3, role: { name: role } };
      await expect(f.service.technicianCustomerDeliveryOptions({}, actor)).rejects.toThrow(ForbiddenException);
      await expect(f.service.technicianDeliverToCustomer(f.dto(), actor)).rejects.toThrow(ForbiddenException);
      await expect(f.service.technicianCustomerDelivery(1, actor)).rejects.toThrow(ForbiddenException);
    }
  });

  it('rejects stale quantities and preserves the signed request atomically', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id);
    const input = f.dto(); await f.collect(run.id, fixed); await f.collect(run.id);
    const before = f.snapshot();
    await expect(f.deliver(input)).rejects.toThrow('changed');
    expect(f.snapshot()).toEqual(before);
    const tooMany = f.dto([{ barcode: door, quantity: 3, version: f.stocks[0].version }]);
    await expect(f.deliver(tooMany)).rejects.toThrow(ForbiddenException);
    expect(f.snapshot()).toEqual(before);
  });

  it('permits only one competing crew member to hand off the same parts', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id);
    const outcomes = await Promise.allSettled([f.deliver(), f.deliver(f.dto(), colleague)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(f.customerDeliveries).toHaveLength(1);
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, released: 1 });
  });

  it('retains physical-count and internal payment/readiness requirements', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id);
    f.counts.push({ id: 11, activeSlot: 1 });
    expect((await f.options()).countOpen).toBe(true);
    await expect(f.deliver()).rejects.toThrow('Physical count');
    f.counts.length = 0; f.order.payment.status = 'PENDING';
    await expect(f.deliver()).rejects.toThrow('Material payment');
    f.order.payment.status = 'PAID'; f.order.status.name = 'Draft';
    await expect(f.deliver()).rejects.toThrow('ready');
    expect(f.customerDeliveries).toHaveLength(0);
    expect(f.stocks[0].inTransit).toBe(1);
  });

  it('does not grant a historical crew access to quantities collected by the next crew', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.scan({ action: 'RECEIVE', barcode: door, partType: 'DOOR', storeId: 1, requestKey: randomUUID() }, admin);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([4]); await f.collect(next.id, door, colleague);
    expect((await f.options()).total).toBe(0);
    expect((await f.options(colleague)).items[0].availableParts).toBe(1);
    await expect(f.deliver()).rejects.toThrow(ForbiddenException);
  });

  it('consumes the delivering crew’s lots even when an earlier different crew still has the same line in transit', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([4]); await f.collect(next.id, door, colleague);
    expect((await f.options()).items[0].lines[0].inTransit).toBe(1);
    expect((await f.options(colleague)).items[0].lines[0].inTransit).toBe(1);
    await f.deliver(f.dto([{ barcode: door, quantity: 1, version: 2 }]), colleague);
    expect((await f.options(colleague)).items).toEqual([]);
    expect((await f.options()).items[0].availableParts).toBe(1);
    await f.deliver();
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, released: 2 });
  });

  it('splits audit allocation across assigned runs without duplicating receipt lines or request keys', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([3]); await f.collect(next.id);
    const input = f.dto(), receipt = await f.deliver(input);
    expect(receipt).toMatchObject({ totalPieces: 1, totalParts: 2, items: [{ lineNumber: door, quantity: 2 }] });
    const releases = f.movements.filter((m) => m.type === 'RELEASE');
    expect(releases).toMatchObject([{ pickupRunId: first.id, quantity: 1 }, { pickupRunId: next.id, quantity: 1 }]);
    expect(new Set(f.movements.map((m) => m.requestKey)).size).toBe(f.movements.length);
    expect(f.stocks[0]).toMatchObject({ inTransit: 0, released: 2, version: 4 });
    expect(await f.deliver(input)).toEqual({ ...receipt, replayed: true });
  });

  it('ignores reversed collection and receipt pairs when reconstructing assigned transit quantities', async () => {
    const f = fixture(), run = await f.start(); await f.collect(run.id); await f.collect(run.id);
    const received = await f.service.scan({ action: 'RECEIVE', barcode: door, partType: 'DOOR', storeId: 1, requestKey: randomUUID() }, admin);
    expect((await f.options()).items[0].availableParts).toBe(1);
    await f.service.undo(received.movement.id, { requestKey: randomUUID() }, admin);
    expect((await f.options()).items[0].availableParts).toBe(2);
    // Undo of factory scans has its own safeguards, so use a clean second run for it.
    const g = fixture(), other = await g.start(); await g.collect(other.id);
    await g.service.undo(g.movements[0].id, { requestKey: randomUUID() }, admin);
    expect((await g.options()).items).toEqual([]);
  });

  it('scopes the inline PO list to one pickup even when the same technician collected that PO on two runs', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([3]); await f.collect(next.id); await f.collect(next.id, fixed);
    expect((await f.options()).items[0].availableParts).toBe(3);
    expect((await f.options(tech, { pickupRunId: String(first.id) })).items[0]).toMatchObject({ availableParts: 1, pieces: 1 });
    const current = await f.options(tech, { pickupRunId: String(next.id), poKey: 'order:1' });
    expect(current.items[0]).toMatchObject({ availableParts: 2, pieces: 2 });
    expect(await f.service.factoryPickupCustomerDeliveryOptions(next.id, { poKey: 'order:1' }, admin)).toEqual(current);
  });

  it.each([admin, tech])('delivers only the chosen pickup lots for $role.name and keeps the pickup open to continue scanning', async (actor) => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([3]); await f.collect(next.id);
    const input = { ...f.dto([{ barcode: door, quantity: 1, version: 2 }]), pickupRunId: next.id };
    const result = actor.role.name === 'admin'
      ? await f.service.deliverToCustomer(input, actor) : await f.deliver(input, actor);
    expect(result).toMatchObject({ totalParts: 1, totalPieces: 1 });
    expect(f.movements.filter(m => m.type === 'RELEASE')).toMatchObject([{ pickupRunId: next.id, customerDeliveryId: result.id, quantity: 1 }]);
    expect((await f.options(tech, { pickupRunId: String(next.id) })).items).toEqual([]);
    expect((await f.options(tech, { pickupRunId: String(first.id) })).items[0].availableParts).toBe(1);
    expect(await f.service.factoryPickup(next.id, actor)).toMatchObject({ status: 'ACTIVE', collectedParts: 1 });
    expect(await f.collect(next.id, fixed, actor)).toMatchObject({ kind: 'COLLECTED', pickup: { id: next.id, status: 'ACTIVE', collectedParts: 2 } });
  });

  it('does not include earlier received parts or unscanned stock in a current pickup delivery', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.scan({ action: 'RECEIVE', barcode: door, partType: 'DOOR', storeId: 1, requestKey: randomUUID() }, admin);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([3]);
    f.stocks[3].inTransit = 1; // Legacy transit without collection evidence for either run.
    expect((await f.service.factoryPickupCustomerDeliveryOptions(first.id, {}, admin)).items).toEqual([]);
    expect((await f.service.factoryPickupCustomerDeliveryOptions(next.id, {}, admin)).items).toEqual([]);
    await f.collect(next.id);
    const input = { ...f.dto([{ barcode: door, quantity: 1, version: f.stocks[0].version }]), pickupRunId: first.id };
    await expect(f.service.deliverToCustomer(input, admin)).rejects.toThrow('this factory pickup');
    expect((await f.service.factoryPickupCustomerDeliveryOptions(next.id, {}, admin)).items[0].availableParts).toBe(1);
  });

  it('rejects over-allocation beyond the selected pickup even if other assigned runs have enough transit', async () => {
    const f = fixture(), first = await f.start([3]); await f.collect(first.id);
    await f.service.finishFactoryPickup(first.id, partial, tech);
    const next = await f.start([3]); await f.collect(next.id);
    const input = { ...f.dto(), pickupRunId: next.id }, before = f.snapshot();
    await expect(f.deliver(input)).rejects.toThrow('this factory pickup');
    await expect(f.service.deliverToCustomer(input, admin)).rejects.toThrow('this factory pickup');
    expect(f.snapshot()).toEqual(before);
  });

  it('validates pickup scope and rejects unauthorized lookup or direct delivery', async () => {
    const f = fixture(), run = await f.start([3]); await f.collect(run.id);
    await expect(f.options(stranger, { pickupRunId: String(run.id) })).rejects.toThrow(NotFoundException);
    await expect(f.options(tech, { pickupRunId: '999' })).rejects.toThrow(NotFoundException);
    for (const pickupRunId of ['', '0', '-1', '1.5', 'abc', '9007199254740993'])
      await expect(f.options(tech, { pickupRunId })).rejects.toThrow('valid factory pickup');
    await expect(f.service.factoryPickupCustomerDeliveryOptions(0, {}, admin)).rejects.toThrow('valid factory pickup');
    await expect(f.service.factoryPickupCustomerDeliveryOptions(999, {}, admin)).rejects.toThrow(NotFoundException);
    for (const role of ['operator', 'technician', 'dealer', 'client'] as const)
      await expect(f.service.factoryPickupCustomerDeliveryOptions(run.id, {}, { id: 3, role: { name: role } })).rejects.toThrow(ForbiddenException);
    const input = { ...f.dto(), pickupRunId: run.id };
    await expect(f.deliver(input, stranger)).rejects.toThrow(NotFoundException);
    await expect(f.service.deliverToCustomer(input, { id: 2, role: { name: 'operator' } })).rejects.toThrow(ForbiddenException);
    await expect(f.service.deliverToCustomer({ ...input, source: 'WAREHOUSE', storeId: 1 }, admin)).rejects.toThrow('valid factory pickup');
    for (const pickupRunId of [0, -1, 1.5, null, '1', Number.MAX_SAFE_INTEGER + 1])
      await expect(f.service.deliverToCustomer({ ...input, pickupRunId } as WarehouseCustomerDeliveryDto, admin)).rejects.toThrow('valid factory pickup');
  });

  it('replays a scoped signed delivery after reassignment and rejects reuse with a different scope', async () => {
    const f = fixture(), run = await f.start([3]); await f.collect(run.id);
    const input = { ...f.dto(), pickupRunId: run.id }, receipt = await f.deliver(input), before = f.snapshot();
    await f.service.assignFactoryPickup(run.id, { technicianIds: [4] }, admin);
    expect(await f.deliver(input)).toEqual({ ...receipt, replayed: true });
    expect(f.snapshot()).toEqual(before);
    await expect(f.deliver({ ...input, pickupRunId: undefined })).rejects.toThrow('another operation');
    await expect(f.deliver({ ...input, pickupRunId: run.id + 1 })).rejects.toThrow('another operation');
  });
});

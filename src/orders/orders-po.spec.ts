import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';

const statuses = ['Pending', 'In production', 'Ready to pick up', 'Picked up', 'Delivered', 'Installation in progress', 'Installed']
  .map((name, index) => ({ id: index + 1, name }));

function fixture(statusName = 'Pending', poNumber: string | null = null) {
  const status = statuses.find((item) => item.name === statusName)!;
  const current = {
    id: 1, number: 1001, idEst: 10, userId: 7,
    statusId: status.id, status, poNumber, rateReal: null,
    saleSubtotal: new Prisma.Decimal(1000), netProfitReal: null,
    estimate: { idUser: 7, installationJob: null },
    user: { role: { name: 'client' } },
    updateStatus: new Date('2026-09-18T12:00:00Z'),
  };
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(current),
      update: jest.fn().mockImplementation(async ({ data }) => ({
        ...current, ...data,
        status: statuses.find((item) => item.id === (data.statusId ?? current.statusId)),
      })),
    },
    orderStatus: { findUnique: jest.fn().mockImplementation(async ({ where }) => statuses.find((item) => item.id === where.id) ?? null) },
    installationJob: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation(async (callback) => callback(prisma)),
  };
  const notifications = { createAndSend: jest.fn() };
  const logs = { log: jest.fn() };
  const workflow = { markOrderReady: jest.fn() };
  const service = new OrdersService(prisma as any, notifications as any, logs as any, workflow as any);
  const actor = { id: 2, role: { name: 'admin' } } as any;
  return { service, prisma, current, notifications, logs, actor };
}

describe('order factory PO requirements', () => {
  it.each([undefined, null, '', '   '])('rejects leaving Pending with PO %p', async (poNumber) => {
    const f = fixture();
    await expect(f.service.update(1, { statusId: 2, poNumber }, f.actor))
      .rejects.toThrow('PO Number is required before moving the order');
    expect(f.prisma.order.update).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it('accepts the PO and production status in the same update', async () => {
    const f = fixture();
    const saved = await f.service.update(1, { statusId: 2, poNumber: '  FACTORY-123  ' }, f.actor);
    expect(saved.poNumber).toBe('FACTORY-123');
    expect(saved.statusId).toBe(2);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
  });

  it('accepts an existing PO when the field is omitted', async () => {
    const f = fixture('Pending', 'FACTORY-123');
    const saved = await f.service.update(1, { statusId: 2 }, f.actor);
    expect(saved.statusId).toBe(2);
    expect(saved.poNumber).toBe('FACTORY-123');
  });

  it('treats legacy whitespace as a missing PO', async () => {
    const f = fixture('Pending', '   ');
    await expect(f.service.update(1, { statusId: 2 }, f.actor)).rejects.toThrow('PO Number is required');
  });

  it.each(statuses.slice(1).map((status) => status.name))('cannot remove an existing PO in %s', async (name) => {
    const f = fixture(name, 'FACTORY-123');
    await expect(f.service.update(1, { poNumber: '  ' }, f.actor))
      .rejects.toThrow('The factory PO cannot be removed after the order leaves Pending.');
    expect(f.prisma.order.update).not.toHaveBeenCalled();
  });

  it('allows correcting a PO without notifying the customer', async () => {
    const f = fixture('In production', 'FACTORY-123');
    const saved = await f.service.update(1, { poNumber: 'FACTORY-456' }, f.actor);
    expect(saved.poNumber).toBe('FACTORY-456');
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it('allows removing a PO while the order is still Pending and has no factory cost', async () => {
    const f = fixture('Pending', 'FACTORY-123');
    const saved = await f.service.update(1, { poNumber: null }, f.actor);
    expect(saved.poNumber).toBeNull();
  });

  it('does not require factory cost to start production', async () => {
    const f = fixture();
    const saved = await f.service.update(1, { statusId: 2, poNumber: 'FACTORY-123', rateReal: null }, f.actor);
    expect(saved.rateReal).toBeNull();
    expect(saved.statusId).toBe(2);
  });

  it('still rejects recording factory cost without a PO', async () => {
    const f = fixture();
    await expect(f.service.update(1, { rateReal: 500 }, f.actor))
      .rejects.toThrow('PO Number is required before recording the real factory cost.');
  });
});

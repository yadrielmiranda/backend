import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';

const statuses = [
  'Pending',
  'In production',
  'Ready to pick up',
  'Picked up',
  'Delivered',
  'Installation in progress',
  'Installed',
].map((name, index) => ({ id: index + 1, name }));

function fixture(statusName = 'Pending', poNumber: string | null = null) {
  const status = statuses.find((item) => item.name === statusName)!;
  const current = {
    id: 1,
    number: 1001,
    idEst: 10,
    userId: 7,
    statusId: status.id,
    status,
    poNumber,
    rateReal: null,
    saleSubtotal: new Prisma.Decimal(1000),
    netProfitReal: null,
    estimate: { idUser: 7, installationJob: null },
    user: { role: { name: 'client' } },
    updateStatus: new Date('2026-09-18T12:00:00Z'),
  };
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(current),
      update: jest.fn().mockImplementation(async ({ data }) => ({
        ...current,
        ...data,
        status: statuses.find(
          (item) => item.id === (data.statusId ?? current.statusId),
        ),
      })),
    },
    orderStatus: {
      findUnique: jest
        .fn()
        .mockImplementation(
          async ({ where }) =>
            statuses.find((item) => item.id === where.id) ?? null,
        ),
    },
    installationJob: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest
      .fn()
      .mockImplementation(async (callback) => callback(prisma)),
  };
  const notifications = { createAndSend: jest.fn() };
  const logs = { log: jest.fn() };
  const workflow = { markOrderReady: jest.fn() };
  const service = new OrdersService(
    prisma as any,
    notifications as any,
    logs as any,
    workflow as any,
  );
  const actor = { id: 2, role: { name: 'admin' } } as any;
  return { service, prisma, current, notifications, logs, actor };
}

describe('order status after factory import', () => {
  it('rejects leaving Pending before a factory PO is imported', async () => {
    const f = fixture();
    await expect(f.service.update(1, { statusId: 2 }, f.actor)).rejects.toThrow(
      'PO Number is required',
    );
    expect(f.prisma.order.update).not.toHaveBeenCalled();
  });

  it('accepts an imported or legacy PO when advancing the status', async () => {
    const f = fixture('Pending', 'FACTORY-123');
    const saved = await f.service.update(1, { statusId: 2 }, f.actor);
    expect(saved.statusId).toBe(2);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
    expect(f.prisma.order.update.mock.calls[0][0].data).not.toHaveProperty(
      'netProfitReal',
    );
    expect(f.prisma.order.update.mock.calls[0][0].data).not.toHaveProperty(
      'rateReal',
    );
  });

  it('treats legacy whitespace as a missing PO', async () => {
    const f = fixture('Pending', '   ');
    await expect(f.service.update(1, { statusId: 2 }, f.actor)).rejects.toThrow(
      'PO Number is required',
    );
  });

  it.each([
    { poNumber: '123' },
    { poNumber: null },
    { rateReal: 500 },
    { rateReal: null },
  ])('routes financial edits through the importer: %p', async (data) => {
    const f = fixture();
    await expect(f.service.update(1, data, f.actor)).rejects.toThrow(
      'Import the factory JSON',
    );
    expect(f.prisma.order.update).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });
});

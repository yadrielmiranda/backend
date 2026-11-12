import { ConfigService } from '@nestjs/config';
import type { InstallationJobStatus, OrderFulfillmentMethod } from '@prisma/client';
import { getPaymentSchedule } from '@/payment-plans/payment-schedule';
import { PaymentsService } from '@/payments/payments.service';
import { OrdersService } from './orders.service';
import { orderStatusNotification } from './order-status-notification';

jest.mock('@/payment-plans/payment-schedule', () => ({
  ...jest.requireActual('@/payment-plans/payment-schedule'),
  getPaymentSchedule: jest.fn(),
}));

const schedule = jest.mocked(getPaymentSchedule);
const statuses = ['Pending', 'In production', 'Awaiting release', 'Preparing for pickup', 'Ready to pick up']
  .map((name, index) => ({ id: index + 1, name }));
const actor = { id: 2, role: { name: 'admin' } } as const;

function fixture(statusName = 'In production', installationStatus?: InstallationJobStatus) {
  const status = statuses.find(item => item.name === statusName)!;
  const order: any = {
    id: 1, number: 'ORD-1003', idEst: 10, userId: 99, statusId: status.id, status,
    poNumber: '293930', fulfillmentMethod: 'UNDECIDED',
    estimate: { idUser: 7, installationJob: installationStatus ? { id: 4, status: installationStatus } : null },
    user: { role: { name: 'dealer' } },
    updateStatus: new Date('2026-11-12T12:00:00Z'), updatedAt: new Date('2026-11-12T12:00:00Z'),
  };
  const db: any = {
    $queryRaw: jest.fn(async () => [{ id: order.idEst }]),
    estimate: { findUnique: jest.fn(async () => ({ materialRevisions: [], installationJob: null })) },
    order: {
      findUnique: jest.fn(async () => order),
      update: jest.fn(async ({ data }) => {
        Object.assign(order, data);
        order.status = statuses.find(item => item.id === order.statusId);
        return order;
      }),
    },
    orderStatus: { findUnique: jest.fn(async ({ where }) => statuses.find(item => item.id === where.id || item.name === where.name)) },
    installationJob: { findUnique: jest.fn(async () => null) },
    eventLog: { create: jest.fn(async () => ({})) },
  };
  db.$transaction = jest.fn(async (work) => work(db));
  const notifications: any = { createAndSend: jest.fn(async () => null) };
  const logs: any = { log: jest.fn() };
  const workflow: any = { markOrderReady: jest.fn() };
  const orders = new OrdersService(db, notifications, logs, workflow);
  const payments = new PaymentsService(db, { get: () => 'sk_test_fixture' } as unknown as ConfigService, workflow, notifications);
  const advance = () => (payments as any).advanceAwaitingReleaseOrder(db, order.idEst, actor.id);
  return { order, db, notifications, orders, advance };
}

beforeEach(() => { schedule.mockReset(); schedule.mockResolvedValue(null); });

describe('Pickup and delivery choice notification', () => {
  it.each([undefined, 'CANCELED'] as const)('asks the estimate owner to choose when staff advances an order with installation %s', async (installation) => {
    const f = fixture('In production', installation);
    await f.orders.update(1, { statusId: 4 }, actor);

    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith({
      recipientId: 7, actorId: 2,
      message: 'Your order #ORD-1003 is preparing for pickup. Please choose Pickup or Delivery to let us know how you will receive it.',
      actionUrl: '/orders/1#pickup-delivery', actionLabel: 'Choose pickup or delivery',
      dedupeKey: `order:1:status:4:${f.order.updateStatus.toISOString()}`,
    });
    expect(f.order.fulfillmentMethod).toBe('UNDECIDED');
  });

  it('keeps the normal status message for an order with active installation', async () => {
    const f = fixture('In production', 'INSTALLATION_PAYMENT_PENDING');
    await f.orders.update(1, { statusId: 4 }, actor);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      message: 'The status of your order #ORD-1003 has changed to "Preparing for pickup".',
      actionUrl: '/orders/1', actionLabel: 'Open order',
    }));
    expect(f.order.fulfillmentMethod).toBe('INSTALLATION_DELIVERY');
  });

  it('does not send another choice notification when the status stays unchanged', async () => {
    const f = fixture('Preparing for pickup');
    await f.orders.update(1, { statusId: 4 }, actor);
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it.each([undefined, 'CANCELED'] as const)('asks once after a release payment automatically advances an order with installation %s', async (installation) => {
    const f = fixture('Awaiting release', installation);
    schedule.mockResolvedValue({ canRelease: true } as any);
    expect(await f.advance()).toBe(true);
    expect(f.notifications.createAndSend).toHaveBeenCalledWith({
      recipientId: 7,
      message: 'Your order #ORD-1003 is preparing for pickup. Please choose Pickup or Delivery to let us know how you will receive it.',
      actionUrl: '/orders/1#pickup-delivery', actionLabel: 'Choose pickup or delivery',
      dedupeKey: `order:1:status:4:${f.order.updateStatus.toISOString()}`,
    }, f.db);
    expect(await f.advance()).toBe(false);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the normal automatic message and installation delivery when installation is active', async () => {
    const f = fixture('Awaiting release', 'INSTALLATION_PAYMENT_PENDING');
    schedule.mockResolvedValue({ canRelease: true } as any);
    await f.advance();
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      message: 'The status of your order #ORD-1003 has changed to "Preparing for pickup".',
      actionUrl: '/orders/1', actionLabel: 'Open order',
    }), f.db);
    expect(f.order.fulfillmentMethod).toBe('INSTALLATION_DELIVERY');
  });

  it('does not ask for delivery selection while the release payment still blocks advancement', async () => {
    const f = fixture('Awaiting release');
    schedule.mockResolvedValue({ canRelease: false } as any);
    expect(await f.advance()).toBe(false);
    expect(f.db.order.update).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it.each(['CUSTOMER_PICKUP', 'FACTORY_PICKUP', 'COMPANY_DELIVERY', 'INSTALLATION_DELIVERY'] as OrderFulfillmentMethod[])(
    'does not ask to choose again for resolved mode %s', (fulfillmentMethod) => {
      expect(orderStatusNotification({ orderId: 1, orderNumber: 'ORD-1003', statusName: 'Preparing for pickup',
        fulfillmentMethod, installationActive: false })).toEqual({
        message: 'The status of your order #ORD-1003 has changed to "Preparing for pickup".',
        actionUrl: '/orders/1', actionLabel: 'Open order',
      });
    },
  );

  it('keeps the regular status message before the choice stage', () => {
    expect(orderStatusNotification({ orderId: 1, orderNumber: 'ORD-1003', statusName: 'In production',
      fulfillmentMethod: 'UNDECIDED', installationActive: false })).toEqual({
      message: 'The status of your order #ORD-1003 has changed to "In production".',
      actionUrl: '/orders/1', actionLabel: 'Open order',
    });
  });
});

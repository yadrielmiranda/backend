import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const gateway = { sendNotificationToUser: jest.fn() };
  const sms = { enqueue: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates an actionable notification', async () => {
    const created = {
      id: 1,
      recipientId: 7,
      message: 'Payment confirmed.',
      actionUrl: '/orders/11',
      actionLabel: 'Open order',
      dedupeKey: null,
      isRead: false,
      createdAt: new Date(),
    };
    const prisma = {
      $transaction: jest.fn(async (work) => work(prisma)),
      notification: {
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
    );

    await expect(
      service.createAndSend({
        recipientId: 7,
        message: 'Payment confirmed.',
        actionUrl: '/orders/11',
        actionLabel: 'Open order',
      }),
    ).resolves.toEqual(created);

    expect(service).toBeDefined();
    expect(sms.enqueue).toHaveBeenCalledWith(created, prisma);
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith(7, created);
  });

  it('does not emit a duplicate notification for the same recipient and key', async () => {
    const existing = {
      id: 2,
      recipientId: 7,
      message: 'Payment confirmed.',
      actionUrl: '/orders/11',
      actionLabel: 'Open order',
      dedupeKey: 'payment:41:paid:admin',
      isRead: false,
      createdAt: new Date(),
    };
    const prisma = {
      $transaction: jest.fn(async (work) => work(prisma)),
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirstOrThrow: jest.fn().mockResolvedValue(existing),
      },
    };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
    );

    await expect(
      service.createAndSend({
        recipientId: 7,
        message: existing.message,
        actionUrl: existing.actionUrl,
        actionLabel: existing.actionLabel,
        dedupeKey: existing.dedupeKey,
      }),
    ).resolves.toEqual(existing);

    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
    expect(sms.enqueue).not.toHaveBeenCalled();
  });

  it('queues a newly inserted deduplicated notification once', async () => {
    const created = { id: 12, recipientId: 7, message: 'Payment confirmed.' };
    const tx = {
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
    );
    await service.createAndSend({
      recipientId: 7,
      message: created.message,
      dedupeKey: 'payment:12:owner',
    });
    expect(sms.enqueue).toHaveBeenCalledTimes(1);
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith(7, created);
  });

  it('uses the caller payment transaction for the notification and its pending SMS', async () => {
    const created = { id: 13, recipientId: 7, message: 'Payment confirmed.' };
    const tx = {
      notification: { create: jest.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: jest.fn(),
      notification: { create: jest.fn() },
    };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
    );
    await service.createAndSend(
      { recipientId: 7, message: created.message },
      tx as never,
    );
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not publish a standalone notification if its transaction fails to commit', async () => {
    const created = { id: 14, recipientId: 7, message: 'Payment confirmed.' };
    const tx = {
      notification: { create: jest.fn().mockResolvedValue(created) },
    };
    const prisma = {
      $transaction: jest.fn(async (work) => {
        await work(tx);
        throw new Error('Commit failed');
      }),
    };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
    );
    await expect(
      service.createAndSend({ recipientId: 7, message: created.message }),
    ).rejects.toThrow('Commit failed');
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
  });
});

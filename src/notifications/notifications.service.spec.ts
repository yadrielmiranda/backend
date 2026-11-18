import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const gateway = { sendNotificationToUser: jest.fn() };
  const sms = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const email = { enqueue: jest.fn().mockResolvedValue(undefined) };

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
      email as never,
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
    expect(email.enqueue).toHaveBeenCalledWith(created, prisma);
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
      email as never,
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
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('queues referral withdrawal alerts for active admins in the reservation transaction and publishes only after commit', async () => {
    const stored: any[] = [];
    let committed = false;
    const tx = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]) },
      notification: {
        createMany: jest.fn(async ({ data }) => {
          const row = data[0];
          if (stored.some(existing => existing.recipientId === row.recipientId && existing.dedupeKey === row.dedupeKey)) return { count: 0 };
          stored.push({ ...row, id: stored.length + 1, isRead: false, createdAt: new Date() });
          return { count: 1 };
        }),
        findFirstOrThrow: jest.fn(async ({ where }) => stored.find(row => row.recipientId === where.recipientId && row.dedupeKey === where.dedupeKey)),
      },
    };
    const prisma = { notification: { findMany: jest.fn(async () => committed ? stored : []) } };
    const service = new NotificationsService(prisma as never, gateway as never, sms as never, email as never);
    const data = {
      actorId: 7,
      message: 'Test Owner requested a referral withdrawal of $120.00 (request #41).',
      actionUrl: '/settings/referrals', actionLabel: 'Review withdrawals',
      dedupeKey: 'referral-payout:41:requested:admin',
    };
    await service.createAndSendToRoles(['admin'], data, { db: tx as never });
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { isActive: true, deletedAt: null, role: { name: { in: ['admin'] } } },
      select: { id: true },
    });
    expect(stored.map(row => row.recipientId)).toEqual([1, 2]);
    for (const row of stored) {
      expect(sms.enqueue).toHaveBeenCalledWith(row, tx);
      expect(email.enqueue).toHaveBeenCalledWith(row, tx);
    }
    await service.publishCommittedNotifications();
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
    committed = true;
    await service.publishCommittedNotifications();
    await service.createAndSendToRoles(['admin'], data, { db: tx as never });
    await service.publishCommittedNotifications();
    expect(stored).toHaveLength(2);
    expect(gateway.sendNotificationToUser).toHaveBeenCalledTimes(2);
    expect(sms.enqueue).toHaveBeenCalledTimes(2);
    expect(email.enqueue).toHaveBeenCalledTimes(2);
  });

  it('publishes an in-app-only storage warning without queuing SMS or email', async () => {
    const created = { id: 48, recipientId: 7, message: 'Attachment storage reached 9 GB.' };
    const tx = { notification: { create: jest.fn().mockResolvedValue(created) } };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
    const service = new NotificationsService(prisma as never, gateway as never, sms as never, email as never);
    await service.createAndSend({ message: created.message, recipientId: 7, inAppOnly: true });
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith(7, created);
    expect(sms.enqueue).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
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
      email as never,
    );
    await service.createAndSend({
      recipientId: 7,
      message: created.message,
      dedupeKey: 'payment:12:owner',
    });
    expect(sms.enqueue).toHaveBeenCalledTimes(1);
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(email.enqueue).toHaveBeenCalledWith(created, tx);
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
      email as never,
    );
    await service.createAndSend(
      { recipientId: 7, message: created.message },
      tx as never,
    );
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(email.enqueue).toHaveBeenCalledWith(created, tx);
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
      email as never,
    );
    await expect(
      service.createAndSend({ recipientId: 7, message: created.message }),
    ).rejects.toThrow('Commit failed');
    expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
    expect(email.enqueue).toHaveBeenCalledWith(created, tx);
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
  });

  it('suppresses the actor across the bell, SMS and email before any write', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
      email as never,
    );
    await expect(
      service.createAndSend({
        recipientId: 7,
        actorId: 7,
        message: 'Installation deposit is due.',
      }),
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sms.enqueue).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
  });

  it('waits for the caller transaction to commit before publishing the bell once', async () => {
    const created = { id: 16, recipientId: 7, message: 'Order created.' };
    const tx = {
      notification: { create: jest.fn().mockResolvedValue(created) },
    };
    const prisma = {
      notification: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([created]),
      },
    };
    const service = new NotificationsService(
      prisma as never,
      gateway as never,
      sms as never,
      email as never,
    );
    await service.createAndSend(
      { recipientId: 7, message: created.message },
      tx as never,
    );
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
    await service.publishCommittedNotifications();
    expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
    await service.publishCommittedNotifications();
    await service.publishCommittedNotifications();
    expect(gateway.sendNotificationToUser).toHaveBeenCalledTimes(1);
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith(7, created);
  });

  it('does not publish an order rolled back by the caller and drops its pending socket event', async () => {
    jest.useFakeTimers();
    try {
      const created = { id: 17, recipientId: 7, message: 'Order created.' };
      const tx = {
        notification: { create: jest.fn().mockResolvedValue(created) },
      };
      const prisma = {
        notification: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new NotificationsService(
        prisma as never,
        gateway as never,
        sms as never,
        email as never,
      );
      await service.createAndSend(
        { recipientId: 7, message: created.message },
        tx as never,
      );
      jest.setSystemTime(Date.now() + 61_000);
      await service.publishCommittedNotifications();
      await service.publishCommittedNotifications();
      expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
      expect(gateway.sendNotificationToUser).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([false, true])(
    'notifies another actor or an explicit order-created exception (%s)',
    async (ownOrder) => {
      const created = {
        id: 15,
        recipientId: 7,
        message: 'Your order was created.',
      };
      const tx = {
        notification: { create: jest.fn().mockResolvedValue(created) },
      };
      const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
      const service = new NotificationsService(
        prisma as never,
        gateway as never,
        sms as never,
        email as never,
      );
      await service.createAndSend({
        recipientId: 7,
        actorId: ownOrder ? 7 : 1,
        notifyActor: ownOrder,
        message: created.message,
      });
      expect(tx.notification.create).toHaveBeenCalledWith({
        data: expect.not.objectContaining({ actorId: expect.anything() }),
      });
      expect(sms.enqueue).toHaveBeenCalledWith(created, tx);
      expect(email.enqueue).toHaveBeenCalledWith(created, tx);
      expect(gateway.sendNotificationToUser).toHaveBeenCalledWith(7, created);
    },
  );
});

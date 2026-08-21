import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const gateway = { sendNotificationToUser: jest.fn() };

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
      notification: {
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const service = new NotificationsService(prisma as never, gateway as never);

    await expect(
      service.createAndSend({
        recipientId: 7,
        message: 'Payment confirmed.',
        actionUrl: '/orders/11',
        actionLabel: 'Open order',
      }),
    ).resolves.toEqual(created);

    expect(service).toBeDefined();
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
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirstOrThrow: jest.fn().mockResolvedValue(existing),
      },
    };
    const service = new NotificationsService(prisma as never, gateway as never);

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
  });
});

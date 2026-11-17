import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';
import { NotificationEmailService } from '@/notifications/notification-email.service';
import { MaterialSaleEmailService } from '@/materials/material-sale-email.service';
import { WelcomeEmailService } from './welcome-email.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('restored email queues outside an enabled production environment', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    [undefined, undefined],
    ['development', undefined],
    ['test', 'true'],
    ['production', 'false'],
    ['production', 'invalid'],
  ])('leaves every restored outbox untouched for NODE_ENV=%s and delivery=%s', async (environment, enabled) => {
    const values: Record<string, string | undefined> = {
      NODE_ENV: environment,
      EMAIL_DELIVERY_ENABLED: enabled,
      // A restored database and copied production SMTP configuration must not
      // allow a local worker to claim or send messages.
      PUBLIC_FRONTEND_URL: 'https://portal.example.test',
      NOTIFICATIONS_SMTP_HOST: 'smtp.example.com',
      NOTIFICATIONS_SMTP_USER: 'notifications@example.com',
      NOTIFICATIONS_SMTP_PASS: 'fake-test-password',
      NOTIFICATIONS_SMTP_FROM_EMAIL: 'notifications@example.com',
    };
    const config = { get: (key: string) => values[key] } as ConfigService;
    const restoredRows = [
      { status: 'PENDING', attempts: 0, createdAt: new Date('2025-01-01') },
      { status: 'SENDING', attempts: 1, attemptedAt: new Date('2025-01-01') },
    ];
    const snapshot = structuredClone(restoredRows);
    const outbox = () => ({
      findMany: jest.fn().mockResolvedValue(restoredRows),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    const db = {
      accountWelcomeEmail: outbox(),
      notificationEmail: outbox(),
      materialSaleEmail: outbox(),
    };
    const emails = new NotificationEmailService(db as never, config);
    const workers = [
      emails,
      new WelcomeEmailService(db as never, emails),
      new MaterialSaleEmailService(db as never, emails),
    ];

    // Two ticks also prove that the interval remains harmless over time.
    for (let tick = 0; tick < 2; tick++) {
      for (const worker of workers) await worker.processPending();
    }

    for (const queue of Object.values(db)) {
      expect(queue.findMany).not.toHaveBeenCalled();
      expect(queue.updateMany).not.toHaveBeenCalled();
    }
    expect(restoredRows).toEqual(snapshot);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('does not access a missing welcome table when email is disabled locally', async () => {
    const config = { get: (key: string) => key === 'NODE_ENV' ? 'development' : undefined } as ConfigService;
    const db = {};
    const emails = new NotificationEmailService(db as never, config);
    const worker = new WelcomeEmailService(db as never, emails);
    await expect(worker.processPending()).resolves.toBeUndefined();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});

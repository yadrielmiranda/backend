import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { NotificationEmailService } from './notification-email.service';
import { MailService } from '@/mail/mail.service';
import { isEmailDeliveryEnabled } from '@/mail/email-delivery-policy';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const createTransport = jest.mocked(nodemailer.createTransport);
const sendMail = jest.fn();
const email = 'client@example.com';

function fixture() {
  const user = {
    email,
    isActive: true,
    deletedAt: null as Date | null,
    dealerMode: null as 'EXTERNAL' | 'INTERNAL' | null,
    role: { name: 'client' },
    registrationConsent: { serviceEmailAccepted: true } as {
      serviceEmailAccepted: boolean;
    } | null,
  };
  const notification = {
    id: 10,
    recipientId: 7,
    message: 'Your order #ORD-1021 was created.',
    actionUrl: '/orders/21',
    actionLabel: 'Open order',
    dedupeKey: 'order:21:created:owner',
    isRead: false,
    createdAt: new Date(),
    recipient: user,
  };
  const row = {
    notificationId: 10,
    email,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(),
    attemptedAt: null as Date | null,
    providerMessageId: null as string | null,
    errorCode: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const values: Record<string, string> = {
    NODE_ENV: 'production',
    NOTIFICATIONS_SMTP_HOST: 'smtp.example.com',
    NOTIFICATIONS_SMTP_PORT: '465',
    NOTIFICATIONS_SMTP_SECURE: 'true',
    NOTIFICATIONS_SMTP_USER: 'notifications@example.com',
    NOTIFICATIONS_SMTP_PASS: 'fake-notifications-secret',
    NOTIFICATIONS_SMTP_FROM_EMAIL: 'notifications@example.com',
    NOTIFICATIONS_SMTP_FROM_NAME: 'Example Company',
    NOTIFICATIONS_SMTP_REPLY_TO: 'sales@example.com',
    PUBLIC_FRONTEND_URL: 'https://portal.example.test',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'no-reply@example.com',
    SMTP_PASS: 'fake-reset-secret',
    SMTP_FROM_EMAIL: 'no-reply@example.com',
    SMTP_FROM_NAME: 'Example Company',
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  const matches = (where: any) =>
    (!where.status || where.status === row.status) &&
    (!where.notificationId || where.notificationId === row.notificationId) &&
    (where.attempts === undefined || where.attempts === row.attempts) &&
    (!where.nextAttemptAt?.lte ||
      row.nextAttemptAt <= where.nextAttemptAt.lte) &&
    (!where.createdAt?.lt || row.createdAt < where.createdAt.lt) &&
    (!where.attemptedAt?.lt ||
      Boolean(row.attemptedAt && row.attemptedAt < where.attemptedAt.lt));
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    notification: { findUnique: jest.fn().mockResolvedValue(notification) },
    notificationEmail: {
      create: jest.fn().mockResolvedValue(row),
      findMany: jest.fn(async ({ where }: any) =>
        matches(where) ? [{ ...row }] : [],
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts?.increment) row.attempts += attempts.increment;
        return { count: 1 };
      }),
    },
  };
  const createService = () =>
    new NotificationEmailService(db as never, config as never);
  return {
    user,
    notification,
    row,
    values,
    config,
    db,
    createService,
    service: createService(),
  };
}

describe('NotificationEmailService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-09-09T12:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    createTransport.mockReturnValue({ sendMail } as never);
    sendMail.mockResolvedValue({
      accepted: [email],
      messageId: '<example-message-id>',
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('dealer application reviewers', () => {
    it.each([
      ['admin', null, 'admin'], ['dealer', 'INTERNAL', 'inviter'], ['dealer', 'EXTERNAL', 'inviter'],
    ] as const)('emails the authorized %s/%s reviewer with a direct review link', async (role, mode, audience) => {
      const f = fixture();
      f.user.role.name = role;
      f.user.dealerMode = mode;
      Object.assign(f.notification, {
        dedupeKey: 'dealer-registration:27:submitted:' + audience,
        message: 'alex submitted a dealer application.',
        actionUrl: '/dealers?registrationRequest=27', actionLabel: 'Review application',
      });
      await f.service.enqueue(f.notification, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Dealer network application awaiting review',
        text: expect.stringContaining('https://portal.example.test/dealers?registrationRequest=27'),
        html: expect.stringContaining('Review application'),
      }));
    });

    it.each([['admin', 'inviter'], ['dealer', 'admin'], ['operator', 'admin'], ['client', 'inviter'],
      ['technician', 'inviter']])('excludes a %s from the %s reviewer email', async (role, audience) => {
      const f = fixture();
      f.user.role.name = role;
      f.notification.dedupeKey = 'dealer-registration:27:submitted:' + audience;
      await f.service.enqueue(f.notification, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe('outbound email policy', () => {
    it.each([
      [undefined, undefined, false],
      [undefined, 'true', false],
      ['development', undefined, false],
      ['development', 'true', false],
      ['test', 'true', false],
      ['staging', 'true', false],
      ['Production', 'true', false],
      ['production ', 'true', false],
      ['production', undefined, true],
      ['production', 'true', true],
      ['production', 'false', false],
      ['production', '', false],
      ['production', 'TRUE', false],
      ['production', '1', false],
      ['production', 'unknown', false],
    ])('allows delivery only for the production policy: %s / %s', (mode, enabled, allowed) => {
      const values = { NODE_ENV: mode, EMAIL_DELIVERY_ENABLED: enabled };
      const config = { get: jest.fn((key: keyof typeof values) => values[key]) };
      expect(isEmailDeliveryEnabled(config as never)).toBe(allowed);
    });

    it.each([
      [undefined, undefined],
      ['development', undefined],
      ['development', 'true'],
      ['test', 'true'],
      ['staging', 'true'],
      ['production', 'false'],
      ['production', 'unknown'],
    ])('blocks every notification mail path and leaves restored pending rows untouched: %s / %s', async (mode, enabled) => {
      const f = fixture();
      if (mode === undefined) delete f.values.NODE_ENV;
      else f.values.NODE_ENV = mode;
      if (enabled !== undefined) f.values.EMAIL_DELIVERY_ENABLED = enabled;
      // A pending row copied from production must not be expired, claimed, or sent locally.
      f.row.createdAt = new Date(Date.now() - 2 * 86_400_000);
      const savedRow = { ...f.row };

      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.service.canSendAccountWelcomeEmail()).toBe(false);
      expect(f.service.canSendMaterialPurchaseEmail()).toBe(false);
      await expect(f.service.sendAccountWelcome({
        to: email, firstName: 'Example', username: 'example', roleName: 'client',
      })).resolves.toEqual({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
      await expect(f.service.sendMaterialPurchaseEmail({
        to: email, path: `/public/material-sales/${'a'.repeat(64)}`,
        customerName: 'Example', saleCode: 'MS-123', total: '48.15', currency: 'USD',
      })).resolves.toEqual({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
      expect(() => f.service.assertEstimateShareReady()).toThrow('Estimate email is unavailable');
      await expect(f.service.sendEstimateShare({
        to: email, path: '/public/estimates/example-token', estimateNumber: '191013',
      })).rejects.toThrow('Estimate email is unavailable');

      expect(f.row).toEqual(savedRow);
      expect(f.db.user.findUnique).not.toHaveBeenCalled();
      expect(f.db.notification.findUnique).not.toHaveBeenCalled();
      for (const method of Object.values(f.db.notificationEmail)) expect(method).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.config.get.mock.calls.every(([key]) => ['NODE_ENV', 'EMAIL_DELIVERY_ENABLED'].includes(key))).toBe(true);
    });
  });

  it('queues and sends a material purchase alert to an admin without enabling unrelated admin emails', async () => {
    const f = fixture(); f.user.role.name = 'admin';
    await f.service.enqueue(f.notification as never, f.db as never);
    expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
    f.notification.dedupeKey = 'material-sale:21:paid';
    f.notification.message = 'Material order #MS-123 from Example Buyer is fully paid (USD 48.15). Ready to prepare for warehouse pickup.';
    f.notification.actionUrl = '/warehouse/materials/sales/21';
    await f.service.enqueue(f.notification as never, f.db as never);
    await f.service.processPending();
    expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Material order paid - Order #MS-123', text: expect.stringContaining('https://portal.example.test/warehouse/materials/sales/21') }));
    expect(f.row.status).toBe('ACCEPTED');
  });

  it.each(['client', 'dealer', 'operator', 'admin'])('sends the online %s buyer an invoice link', async role => {
    const f = fixture(); f.user.role.name = role; f.user.dealerMode = 'INTERNAL';
    f.notification.dedupeKey = 'material-sale:21:paid:customer';
    f.notification.message = 'Your material order #MS-123 is paid in full (USD 48.15). Show your order number or invoice at warehouse pickup.';
    f.notification.actionUrl = `/public/material-sales/${'a'.repeat(64)}`;
    f.notification.actionLabel = 'View order and invoice';
    await f.service.enqueue(f.notification as never, f.db as never);
    await f.service.processPending();
    expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(f.notification.actionUrl) }));
    expect(f.row.status).toBe('ACCEPTED');
  });

  it('rechecks the admin recipient role before sending a staff material alert', async () => {
    const f = fixture(); f.user.role.name = 'admin'; f.notification.dedupeKey = 'material-sale:21:paid';
    await f.service.enqueue(f.notification as never, f.db as never);
    f.user.role.name = 'client';
    await f.service.processPending();
    expect(sendMail).not.toHaveBeenCalled();
    expect(f.row.status).toBe('SKIPPED');
  });

  describe('referral withdrawal notifications', () => {
    function withdrawalFixture() {
      const f = fixture();
      f.user.role.name = 'admin';
      Object.assign(f.notification, {
        dedupeKey: 'referral-payout:18:requested:admin',
        message: 'Example Dealer requested a referral withdrawal of USD 125.50 (request #18).',
        actionUrl: '/settings/referrals',
        actionLabel: 'Review withdrawals',
      });
      return f;
    }

    it('queues and sends the admin email independently of SMS preferences', async () => {
      const f = withdrawalFixture();
      f.user.registrationConsent!.serviceEmailAccepted = false;
      Object.assign(f.user, { smsConsent: { enabled: false, promotionsEnabled: false } });
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.notificationEmail.create).toHaveBeenCalledWith({ data: { notificationId: 10, email } });
      expect(sendMail).not.toHaveBeenCalled();
      await f.service.processPending();
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: email,
        subject: 'Referral withdrawal #18 requested',
        text: expect.stringContaining(f.notification.message),
        html: expect.stringContaining('Review withdrawals'),
      }));
      expect(sendMail.mock.calls[0][0].text).toContain('https://portal.example.test/settings/referrals');
      expect(f.row.status).toBe('ACCEPTED');
    });

    it.each(['operator', 'client', 'dealer', 'technician', 'inactive'])(
      'rejects new and queued withdrawal emails after the admin becomes %s', async change => {
        const f = withdrawalFixture();
        await f.service.enqueue(f.notification as never, f.db as never);
        expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
        f.db.notificationEmail.create.mockClear();
        if (change === 'inactive') f.user.isActive = false;
        else f.user.role.name = change;
        f.user.dealerMode = 'EXTERNAL';
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();
        expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
        expect(sendMail).not.toHaveBeenCalled();
        expect(f.row.status).toBe('SKIPPED');
      },
    );

    it('keeps withdrawal email disabled in development even with the delivery flag enabled', async () => {
      const f = withdrawalFixture();
      f.values.NODE_ENV = 'development';
      f.values.EMAIL_DELIVERY_ENABLED = 'true';
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('PENDING');
    });
  });

  describe('selected staff notifications', () => {
    const adminEvents = [
      ['payment:31:paid:admin', 'Payment confirmed'],
      ['payment:31:partial:pi_example:admin', 'Partial payment received'],
      ['payment:31:partial:2026-11-18T15:00:00.000Z:admin', 'Partial payment received'],
      ['payment:31:received:stripe:ch_example:admin', 'Payment received'],
      ['payment:31:received:checkout:cs_test_example:admin', 'Payment received'],
      ['payment:31:received:manual:12345678-1234-4234-8234-123456789abc:admin', 'Payment received'],
      ['refund:re_example:review', 'Refund recorded'],
      ['order:21:created:admin', 'Order created'],
      ['order:21:pickup:selected:admin', 'Pickup selected'],
      ['order:21:delivery:32:selected:admin', 'Delivery selected'],
      ['installation:33:quote:34:customer:APPROVED:admin', 'Installation quote approved by owner'],
      ['installation:33:quote:34:customer:REJECTED:admin', 'Installation quote rejected by owner'],
      ['installation:33:appointment:35:response:ACCEPT:admin', 'Appointment response received'],
      ['installation:33:appointment:35:response:REQUEST_RESCHEDULE:admin', 'Appointment response received'],
      ['order:21:extra:36:response:PAYMENT_DUE:admin', 'Extra charge response received'],
      ['order:21:extra:36:response:REJECTED:admin', 'Extra charge response received'],
      ['network-business:37:requested', 'Business status change requested'],
      ['network-business:37:applied:admin', 'Business status changed'],
      ['estimate-note-storage:warning:68e638a2-1023-4b3c-86a3-06ef0f0149ac', 'Attachment storage nearly full'],
    ];
    const directStaffEvents = [
      'installation:33:appointment:35:response:ACCEPT',
      'installation:33:appointment:35:response:REQUEST_RESCHEDULE',
      'order:21:extra:36:response:PAYMENT_DUE:creator',
      'order:21:extra:36:response:REJECTED:creator',
    ];

    it.each(adminEvents)('queues and sends the requested admin event %s with its own subject', async (dedupeKey, title) => {
      const f = fixture();
      f.user.role.name = 'admin';
      f.notification.dedupeKey = dedupeKey;
      f.notification.message = 'An operational event for Estimate #191013 requires review.';
      f.notification.actionUrl = '/estimates/104';
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
      expect(sendMail).not.toHaveBeenCalled();
      await f.service.processPending();
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: email, subject: `${title} - Estimate #191013`,
        text: expect.stringContaining('https://portal.example.test/estimates/104'),
      }));
      expect(f.row.status).toBe('ACCEPTED');
    });

    it.each(directStaffEvents.flatMap(key => ['admin', 'operator'].map(role => [key, role])))(
      'delivers response %s to its %s proposer or creator', async (dedupeKey, role) => {
        const f = fixture(); f.user.role.name = role; f.notification.dedupeKey = dedupeKey;
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();
        expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
        expect(sendMail).toHaveBeenCalledTimes(1);
        expect(f.row.status).toBe('ACCEPTED');
      },
    );

    it.each(adminEvents.map(([key]) => key))('does not widen admin-only event %s to operators', async dedupeKey => {
      const f = fixture(); f.user.role.name = 'operator'; f.notification.dedupeKey = dedupeKey;
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it.each(['payment:31:paid:admin', 'payment:31:received:stripe:ch_example:admin', 'order:21:created:admin'].flatMap(key =>
      ['client', 'dealer', 'operator', 'technician'].map(role => [key, role]),
    ))('rechecks staff-only event %s if the queued admin becomes %s', async (dedupeKey, role) => {
      const f = fixture(); f.user.role.name = 'admin'; f.notification.dedupeKey = dedupeKey;
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
      f.user.role.name = role; f.user.dealerMode = 'EXTERNAL';
      await f.service.processPending();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it.each(['order:21:created:admin', 'payment:31:received:stripe:ch_example:admin'])(
      'keeps admin event %s disabled in development', async dedupeKey => {
        const f = fixture(); f.user.role.name = 'admin'; f.notification.dedupeKey = dedupeKey;
        f.values.NODE_ENV = 'development';
        f.values.EMAIL_DELIVERY_ENABLED = 'true';
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();
        expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
        expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
        expect(sendMail).not.toHaveBeenCalled();
        expect(f.row.status).toBe('PENDING');
      },
    );

    it.each([
      'Payment of $450.00 received for Estimate #191013. Remaining balance: $550.00.',
      'Full payment of $1,000.00 received for Estimate #191013. Remaining balance: $0.00.',
    ])('preserves actual payment and balance details independently of SMS consent: %s', async message => {
      const f = fixture(); f.user.role.name = 'admin';
      f.notification.dedupeKey = 'payment:31:received:stripe:ch_example:admin';
      f.notification.message = message;
      Object.assign(f.user, { smsConsent: { enabled: false, promotionsEnabled: false } });
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      await f.service.processPending();
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Payment received - Estimate #191013', text: expect.stringContaining(message),
      }));
      expect(f.row.status).toBe('ACCEPTED');
    });

    it.each([
      'installation:33:remeasurement-completed:admin',
      'installation:33:quote:34:admin-approval',
      'material-revision:38:applied',
      'order:21:status:2:2026-11-18T15:00:00.000Z',
      'network-business:37:reviewed',
    ])('leaves unrelated admin event %s internal', async dedupeKey => {
      const f = fixture(); f.user.role.name = 'admin'; f.notification.dedupeKey = dedupeKey;
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it.each(['inactive', 'deleted', 'invalid-email'])('still rejects a selected staff event for an %s recipient', async reason => {
      const f = fixture(); f.user.role.name = 'admin'; f.notification.dedupeKey = 'payment:31:paid:admin';
      if (reason === 'inactive') f.user.isActive = false;
      if (reason === 'deleted') f.user.deletedAt = new Date();
      if (reason === 'invalid-email') f.user.email = 'invalid';
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });

    it.each([
      'installation:33:deposit-due:owner',
      'installation:33:no-deposit:owner',
      'installation:33:canceled:admin',
    ])('suppresses obsolete installation event %s including an already queued email', async dedupeKey => {
      const f = fixture(); f.notification.dedupeKey = dedupeKey;
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it('preserves the owner notice when a paid installation is canceled', async () => {
      const f = fixture(); f.notification.dedupeKey = 'installation:33:canceled:owner';
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(f.row.status).toBe('ACCEPTED');
    });
  });

  describe('internal dealer project email', () => {
    const statusKey = 'order:21:status:2:2026-09-09T12:00:00.000Z';
    const internalDealer = () => {
      const f = fixture();
      f.user.role.name = 'dealer';
      f.user.dealerMode = 'INTERNAL';
      f.notification.dedupeKey = statusKey;
      f.notification.message = 'The status of your order #ORD-1021 has changed to "In production".';
      return f;
    };

    it('queues and sends the owner status email once independently of SMS preferences', async () => {
      const f = internalDealer();
      f.user.registrationConsent!.serviceEmailAccepted = false;
      Object.assign(f.user, { smsConsent: { enabled: false, promotionsEnabled: false } });
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
      expect(f.db.notificationEmail.create).toHaveBeenCalledWith({ data: { notificationId: 10, email } });
      await f.service.processPending();
      await f.service.processPending();
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0]).toMatchObject({ to: email, subject: 'Order #ORD-1021 status updated' });
      expect(f.row.status).toBe('ACCEPTED');
    });

    it.each([
      ['estimate:104:order-review:owner', 'Payment confirmed for Estimate #191013. Pending order review.', '/estimates/104/edit'],
      ['order:21:created:owner', 'Your order #ORD-1021 has been created from Estimate #191013.', '/orders/21'],
      ['order:21:delivery:3:scheduled:2026-09-09T12:00:00.000Z', 'Delivery scheduled for Order #ORD-1021.', '/orders/21'],
      ['order:21:installation-balance-due', 'The next project installment is due for Order #ORD-1021.', '/orders/21'],
      ['installation:5:quote:8:admin:APPROVED:owner', 'Your installation quote was approved.', '/installations/5'],
      ['installation:5:appointment:9:proposed:owner', 'A date was proposed for your installation.', '/installations/5'],
      ['installation:5:completed:owner', 'Your installation is complete.', '/installations/5'],
      ['installation:5:canceled:owner', 'Your paid installation was canceled.', '/installations/5'],
      ['payment:12:paid:owner', 'Payment confirmed for Estimate #191013.', '/orders/21'],
      ['payment:12:paid:stripe:ch_example:12:owner', 'Payment confirmed for Estimate #191013.', '/orders/21'],
      ['payment:12:paid:manual:12345678-1234-4234-8234-123456789abc:owner', 'Payment confirmed for Estimate #191013.', '/orders/21'],
      ['payment:12:partial:pi_example:owner', 'Partial payment confirmed for Estimate #191013.', '/orders/21'],
      ['payment:12:partial:manual:12345678-1234-4234-8234-123456789abc:owner', 'Partial payment confirmed for Estimate #191013.', '/orders/21'],
      ['payment:12:received:stripe:ch_example:owner', 'Payment of $450.00 received for Estimate #191013. Remaining balance: $550.00.', '/orders/21'],
      ['payment:12:received:checkout:cs_test_example:owner', 'Payment of $450.00 received for Estimate #191013. Remaining balance: $550.00.', '/orders/21'],
      ['payment:12:received:manual:12345678-1234-4234-8234-123456789abc:owner', 'Full payment of $1,000.00 received for Estimate #191013. Remaining balance: $0.00.', '/orders/21'],
    ])('queues and sends the existing owner event %s', async (dedupeKey, message, actionUrl) => {
      const f = internalDealer();
      Object.assign(f.notification, { dedupeKey, message, actionUrl });
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
      expect(f.db.notificationEmail.create).toHaveBeenCalledWith({ data: { notificationId: 10, email } });
      await f.service.processPending();
      await f.service.processPending();
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: email, text: expect.stringContaining(message) }));
      expect(sendMail.mock.calls[0][0].text).toContain(`https://portal.example.test${actionUrl}`);
      expect(f.row.status).toBe('ACCEPTED');
    });

    it.each([
      'payment:12:paid:admin',
      'payment:12:partial:pi_example:admin',
      'refund:re_example:review',
      'order:21:pickup:selected:admin',
      'order:21:extra:3:response:PAYMENT_DUE:creator',
      'installation:5:appointment:9:response:ACCEPT',
      'installation:5:deposit-due:owner',
      'installation:5:no-deposit:owner',
      'installation:5:canceled:admin',
      'material-sale:21:paid',
      'network-business:37:reviewed',
      'order:21:status:2',
      'order:21:status:2:2026-09-09T12:00:00.000Z:admin',
      '',
    ])('keeps staff-only, retired, and non-project event %s excluded for internal dealers', async dedupeKey => {
      const f = internalDealer();
      f.notification.dedupeKey = dedupeKey;
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it.each(['inactive', 'deleted', 'invalid-email'])(
      'rejects an %s internal dealer both at enqueue and before sending', async reason => {
        const f = internalDealer();
        if (reason === 'inactive') f.user.isActive = false;
        if (reason === 'deleted') f.user.deletedAt = new Date();
        if (reason === 'invalid-email') f.user.email = 'bad\r\nBcc: someone@example.com';
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();
        expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
        expect(sendMail).not.toHaveBeenCalled();
        expect(f.row.status).toBe('SKIPPED');
      },
    );

    it('does not redirect a queued internal dealer email to a changed address', async () => {
      const f = internalDealer();
      await f.service.enqueue(f.notification as never, f.db as never);
      f.user.email = 'changed@example.com';
      await f.service.processPending();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    });

    it.each(['order:21:created:owner', 'estimate:104:order-review:owner', 'payment:12:received:stripe:ch_example:owner', statusKey])('keeps internal dealer event %s disabled in development', async dedupeKey => {
      const f = internalDealer();
      f.notification.dedupeKey = dedupeKey;
      f.values.NODE_ENV = 'development';
      f.values.EMAIL_DELIVERY_ENABLED = 'true';
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.updateMany).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['client', null, true],
    ['dealer', 'EXTERNAL', true],
    ['dealer', null, true],
    ['dealer', 'INTERNAL', true],
    ['admin', null, false],
    ['operator', null, false],
  ])(
    'queues only the intended audience: %s / %s',
    async (role, mode, allowed) => {
      const f = fixture();
      f.user.role.name = role as string;
      f.user.dealerMode = mode as typeof f.user.dealerMode;
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.notificationEmail.create).toHaveBeenCalledTimes(
        allowed ? 1 : 0,
      );
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it.each(['inactive', 'deleted', 'invalid-email'])(
    'does not enqueue %s recipients',
    async (reason) => {
      const f = fixture();
      if (reason === 'inactive') f.user.isActive = false;
      if (reason === 'deleted') f.user.deletedAt = new Date();
      if (reason === 'invalid-email')
        f.user.email = 'bad\r\nBcc: someone@example.com';
      await f.service.enqueue(f.notification as never, f.db as never);
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
    },
  );

  it('supports service emails for legacy accounts independently of SMS consent', async () => {
    const f = fixture();
    f.user.registrationConsent = null;
    await f.service.enqueue(f.notification as never, f.db as never);
    expect(f.db.notificationEmail.create).toHaveBeenCalledWith({
      data: { notificationId: 10, email },
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('queues and sends operational email with SMS and historical email consent off', async () => {
    const f = fixture();
    f.user.registrationConsent!.serviceEmailAccepted = false;
    Object.assign(f.user, { smsConsent: { enabled: false, promotionsEnabled: false } });
    await f.service.enqueue(f.notification as never, f.db as never);
    expect(f.db.notificationEmail.create).toHaveBeenCalledWith({ data: { notificationId: 10, email } });
    await f.service.processPending();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(f.row.status).toBe('ACCEPTED');
  });

  it.each(['PASS', 'HOST', 'FROM_EMAIL'])(
    'never substitutes no-reply when notification %s is missing',
    async (key) => {
      const f = fixture();
      delete f.values[`NOTIFICATIONS_SMTP_${key}`];
      await f.service.enqueue(f.notification as never, f.db as never);
      await f.service.processPending();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    },
  );

  it('uses notification SMTP credentials and reply-to with a safe actionable message', async () => {
    const f = fixture();
    f.notification.message = '<img src=x onerror=alert(1)>\nOrder created.';
    f.notification.actionLabel = '<Open order>';
    f.notification.actionUrl = '/orders/21?a=1&b=2';
    await f.service.processPending();
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: {
          user: 'notifications@example.com',
          pass: 'fake-notifications-secret',
        },
      }),
    );
    const message = sendMail.mock.calls[0][0];
    expect(message.from).toEqual({
      name: 'Example Company',
      address: 'notifications@example.com',
    });
    expect(message.replyTo).toBe('sales@example.com');
    expect(message.to).toBe(email);
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).toContain('&lt;img');
    expect(message.html).toContain('&lt;Open order&gt;');
    expect(message.html).toContain(
      'https://portal.example.test/orders/21?a=1&amp;b=2',
    );
    expect(message.html).not.toContain('<img');
    expect(f.row.status).toBe('ACCEPTED');
    expect(f.row.providerMessageId).toBe('<example-message-id>');
    expect(f.row.attempts).toBe(1);
  });

  it.each([
    '//evil.test/path',
    '/\\evil.test/path',
    'https://evil.test/path',
    'javascript:alert(1)',
  ])('does not link outside the portal: %s', async (url) => {
    const f = fixture();
    f.notification.actionUrl = url;
    await f.service.processPending();
    expect(sendMail.mock.calls[0][0].html).toContain(
      'href="https://portal.example.test/"',
    );
    expect(sendMail.mock.calls[0][0].html).not.toContain('evil.test');
  });

  it.each(['email', 'role', 'inactive'])(
    'rechecks the recipient before sending when %s changed',
    async (change) => {
      const f = fixture();
      if (change === 'email') f.user.email = 'someoneelse@example.com';
      if (change === 'role') {
        f.user.role.name = 'technician';
      }
      if (change === 'inactive') f.user.isActive = false;
      await f.service.processPending();
      expect(f.row.status).toBe('SKIPPED');
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it('allows only one of two PM2 workers to send the same email', async () => {
    const f = fixture();
    await Promise.all([
      f.service.processPending(),
      f.createService().processPending(),
    ]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
    await f.service.processPending();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('retries explicit temporary SMTP rejection with backoff and a limit', async () => {
    const f = fixture();
    sendMail.mockRejectedValue({ responseCode: 451 });
    await f.service.processPending();
    expect(f.row.status).toBe('PENDING');
    await f.service.processPending();
    expect(sendMail).toHaveBeenCalledTimes(1);
    jest.setSystemTime(f.row.nextAttemptAt);
    await f.service.processPending();
    jest.setSystemTime(f.row.nextAttemptAt);
    await f.service.processPending();
    expect(f.row.status).toBe('FAILED');
    expect(f.row.errorCode).toBe('SMTP_451');
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent SMTP rejection', async () => {
    const f = fixture();
    sendMail.mockRejectedValue({ responseCode: 550 });
    await f.service.processPending();
    await f.service.processPending();
    expect(f.row.status).toBe('FAILED');
    expect(f.row.errorCode).toBe('SMTP_550');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an ambiguous timeout or expose the error contents', async () => {
    const f = fixture();
    sendMail.mockRejectedValue(
      new Error('secret fake-notifications-secret client@example.com'),
    );
    await f.service.processPending();
    await f.service.processPending();
    expect(f.row.status).toBe('UNKNOWN');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls),
    ).not.toContain('fake-notifications-secret');
    expect(
      JSON.stringify(jest.mocked(Logger.prototype.error).mock.calls),
    ).not.toContain(email);
  });

  it.each(['expired', 'interrupted'])(
    'does not send %s entries',
    async (state) => {
      const f = fixture();
      if (state === 'expired')
        f.row.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      else {
        f.row.status = 'SENDING';
        f.row.attemptedAt = new Date(Date.now() - 11 * 60 * 1000);
      }
      await f.service.processPending();
      expect(f.row.status).toBe(state === 'expired' ? 'SKIPPED' : 'UNKNOWN');
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it('does not treat an unconfirmed SMTP response as delivery', async () => {
    const f = fixture();
    sendMail.mockResolvedValue({
      accepted: [],
      messageId: '<example-message-id>',
    });
    await f.service.processPending();
    expect(f.row.status).toBe('UNKNOWN');
  });

  it('keeps password reset on its own unchanged no-reply transport', async () => {
    const f = fixture();
    const resetMailer = new MailService(
      f.config as never,
      {
        branding: {
          findFirst: jest.fn().mockResolvedValue({ name: 'Example Company' }),
        },
      } as never,
    );
    await resetMailer.sendPasswordResetEmail({
      to: email,
      resetLink: 'https://portal.example.test/reset',
      expiresInMinutes: 30,
    });
    expect(createTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        auth: { user: 'no-reply@example.com', pass: 'fake-reset-secret' },
      }),
    );
    expect(sendMail.mock.calls[0][0].from).toBe(
      '"Example Company" <no-reply@example.com>',
    );
    await f.service.processPending();
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auth: {
          user: 'notifications@example.com',
          pass: 'fake-notifications-secret',
        },
      }),
    );
  });

  describe('guest material purchase email', () => {
    const purchase = () => ({
      to: email, customerName: 'Guest Buyer', saleCode: 'MS-123',
      total: '48.15', currency: 'USD', path: `/public/material-sales/${'a'.repeat(64)}`,
    });

    it('sends the paid invoice using notification branding and credentials without requiring an account', async () => {
      const f = fixture();
      expect(f.service.canSendMaterialPurchaseEmail()).toBe(true);
      expect(createTransport).not.toHaveBeenCalled();
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({ status: 'ACCEPTED', providerMessageId: '<example-message-id>' });
      const message = sendMail.mock.calls[0][0];
      expect(message).toMatchObject({
        to: email, from: { name: 'Example Company', address: 'notifications@example.com' },
        replyTo: 'sales@example.com', subject: 'Material order #MS-123 paid',
      });
      expect(message.text).toContain('Hello Guest Buyer,');
      expect(message.text).toContain('paid in full (USD 48.15)');
      expect(message.text).toContain(`https://portal.example.test${purchase().path}`);
      expect(message.text).toContain('Show your order number or invoice at warehouse pickup.');
      expect(message).not.toHaveProperty('attachments');
      expect(f.db.user.findUnique).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
    });

    it('escapes the guest name and strips header line breaks', async () => {
      const f = fixture();
      await f.service.sendMaterialPurchaseEmail({ ...purchase(), customerName: '<script>alert(1)</script>', saleCode: 'MS-123\r\nBcc: other@example.com' });
      const message = sendMail.mock.calls[0][0];
      expect(message.subject).not.toMatch(/[\r\n]/);
      expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(message.html).not.toContain('<script>');
    });

    it.each([
      'https://evil.test/public/material-sales/token', '//evil.test/path', '/warehouse/materials/sales/1',
      `/public/material-sales/${'a'.repeat(64)}?redirect=bad`, `/public/material-sales/${'a'.repeat(63)}`,
      `/public/material-sales/${'g'.repeat(64)}`, '/public/material-sales/../orders/1',
    ])('rejects an unsafe invoice path without contacting SMTP: %s', async path => {
      const f = fixture();
      await expect(f.service.sendMaterialPurchaseEmail({ ...purchase(), path })).resolves.toEqual({ status: 'FAILED', errorCode: 'INVALID_INVOICE_LINK' });
      expect(sendMail).not.toHaveBeenCalled();
    });

    it.each(['bad', 'guest@example.com,other@example.com', 'guest@example.com\r\nBcc: other@example.com'])(
      'rejects an invalid guest email: %s', async to => {
        const f = fixture();
        await expect(f.service.sendMaterialPurchaseEmail({ ...purchase(), to })).resolves.toEqual({ status: 'FAILED', errorCode: 'INVALID_RECIPIENT' });
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    it.each([['NaN', 'USD'], ['-1.00', 'USD'], ['1.001', 'USD'], ['10.00', 'USD\r\n']])(
      'rejects an invalid amount or currency: %s %s', async (total, currency) => {
        const f = fixture();
        await expect(f.service.sendMaterialPurchaseEmail({ ...purchase(), total, currency })).resolves.toEqual({ status: 'FAILED', errorCode: 'INVALID_INVOICE_AMOUNT' });
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    it('defers without using password-reset credentials when notification email is not ready', async () => {
      const f = fixture(); delete f.values.NOTIFICATIONS_SMTP_PASS;
      expect(f.service.canSendMaterialPurchaseEmail()).toBe(false);
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
      expect(createTransport).not.toHaveBeenCalled();
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
    });

    it.each([[451, 'RETRY'], [550, 'FAILED'], [450.5, 'UNKNOWN']])('classifies an explicit SMTP %s safely as %s', async (responseCode, status) => {
      const f = fixture(); sendMail.mockRejectedValue({ responseCode, message: 'private SMTP password' });
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({
        status, errorCode: status === 'UNKNOWN' ? 'SMTP_CONNECTION_ERROR' : `SMTP_${responseCode}`,
      });
    });

    it('does not turn an ambiguous timeout into a retriable failure', async () => {
      const f = fixture(); sendMail.mockRejectedValue(new Error('secret guest@example.com fake-notifications-secret'));
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({ status: 'UNKNOWN', errorCode: 'SMTP_CONNECTION_ERROR' });
    });

    it.each([undefined, {}, { accepted: [] }, { accepted: ['other@example.com'] }])('treats unconfirmed SMTP acceptance as unknown: %s', async response => {
      const f = fixture(); sendMail.mockResolvedValue(response);
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({ status: 'UNKNOWN', errorCode: 'INVALID_SMTP_RESPONSE' });
    });

    it('honors an explicitly rejected recipient over a conflicting accepted list', async () => {
      const f = fixture(); sendMail.mockResolvedValue({ accepted: [email], rejected: [{ address: email }] });
      await expect(f.service.sendMaterialPurchaseEmail(purchase())).resolves.toEqual({ status: 'FAILED', errorCode: 'RECIPIENT_REJECTED' });
    });

    it('accepts a normalized address-object SMTP result', async () => {
      const f = fixture(); sendMail.mockResolvedValue({ accepted: [{ address: email.toUpperCase() }] });
      await expect(f.service.sendMaterialPurchaseEmail({ ...purchase(), to: ` ${email.toUpperCase()} ` })).resolves.toEqual({ status: 'ACCEPTED' });
      expect(sendMail.mock.calls[0][0].to).toBe(email);
    });
  });

  describe('direct estimate email', () => {
    const share = () => ({
      to: email,
      path: '/public/estimates/total_customer-token',
      estimateNumber: '260067',
      ownerBrandingName: 'Owner Windows',
      ownerEmail: 'owner@example.com',
      customerName: 'Jane Rivera',
      projectName: 'Rivera residence',
    });

    it('checks readiness without connecting to SMTP or the notification queue', () => {
      const f = fixture();
      expect(() => f.service.assertEstimateShareReady()).not.toThrow();
      expect(createTransport).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
    });

    it('sends an owner-branded customer estimate link using notification SMTP only', async () => {
      const f = fixture();
      await expect(f.service.sendEstimateShare(share())).resolves.toEqual({ sent: true });
      expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
        auth: { user: 'notifications@example.com', pass: 'fake-notifications-secret' },
        disableFileAccess: true,
        disableUrlAccess: true,
      }));
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
      const message = sendMail.mock.calls[0][0];
      expect(message).toMatchObject({
        from: { name: 'Example Company', address: 'notifications@example.com' },
        to: email,
        replyTo: 'owner@example.com',
        subject: 'Estimate #260067 ready to review',
      });
      expect(message.text).toContain('Hello Jane Rivera,');
      expect(message.text).toContain('Owner Windows has shared estimate #260067 for Rivera residence with you.');
      expect(message.text).toContain('https://portal.example.test/public/estimates/total_customer-token');
      expect(message.html).toContain('href="https://portal.example.test/public/estimates/total_customer-token"');
      expect(message.text).not.toContain('contract');
      expect(message).not.toHaveProperty('attachments');
      expect(message).not.toHaveProperty('cc');
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
      expect(f.db.notificationEmail.updateMany).not.toHaveBeenCalled();
      expect(f.db.user.findUnique).not.toHaveBeenCalled();
    });

    it('includes the prepared agreement link when sharing a contract', async () => {
      const f = fixture();
      const path = '/public/estimates/customer-token/agreements/agreement-id';
      await f.service.sendEstimateShare({ ...share(), path });
      const message = sendMail.mock.calls[0][0];
      expect(message.text).toContain('Please review your estimate and contract');
      expect(message.text).toContain(`https://portal.example.test${path}`);
      expect(message.html).toContain('Review estimate and contract');
      expect(message).not.toHaveProperty('attachments');
    });

    it('uses only the configured public origin and escapes customer and owner text', async () => {
      const f = fixture();
      f.values.PUBLIC_FRONTEND_URL = 'https://configured.example.test/portal?ignore=1';
      await f.service.sendEstimateShare({
        ...share(),
        estimateNumber: '260067\r\nBcc: another@example.com',
        ownerBrandingName: '<img src=x onerror="alert(1)"> & Owner',
        customerName: '<script>alert(1)</script>',
        projectName: 'Jane\'s "Home" & <Project>',
      });
      const message = sendMail.mock.calls[0][0];
      expect(message.subject).not.toMatch(/[\r\n]/);
      expect(message.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Owner');
      expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(message.html).toContain('Jane&#039;s &quot;Home&quot; &amp; &lt;Project&gt;');
      expect(message.html).not.toMatch(/<img|<script/);
      expect(message.html).toContain('href="https://configured.example.test/public/estimates/total_customer-token"');
      expect(message.html).not.toContain('ignore=1');
      expect(message.html).not.toContain('portal.example.test');
    });

    it.each([
      'https://evil.example/public/estimates/token',
      '//evil.example/public/estimates/token',
      '/\\evil.example/public/estimates/token',
      '/public/estimates/token?redirect=https://evil.example',
      '/public/estimates/../orders/1',
      '/public/estimates/%2e%2e',
      '/orders/1',
    ])('rejects an invalid or externally supplied sharing path: %s', async (path) => {
      const f = fixture();
      await expect(f.service.sendEstimateShare({ ...share(), path })).rejects.toThrow('valid customer estimate link');
      expect(sendMail).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    });

    it.each([
      '', 'invalid', 'a@example.com,b@example.com', 'a@example.com,invalid', 'a@example.com,', ',a@example.com',
      'a@example.com,,b@example.com', 'a@example.com;b@example.com',
      'a@example.com\r\nBcc: b@example.com', 'a@example.com,\nb@example.com',
      Array.from({ length: 11 }, (_, index) => `customer${index}@example.com`).join(','),
      `a@example.com${' '.repeat(4096)}`, `${'a'.repeat(65)}@example.com`,
    ])(
      'rejects an invalid recipient without sending: %s', async (to) => {
        const f = fixture();
        await expect(f.service.sendEstimateShare({ ...share(), to })).rejects.toThrow('valid recipient email');
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    it.each([
      { to: undefined }, { to: null }, { to: 123 }, { to: [email] },
    ])('never promotes CC when the primary recipient is missing or has an invalid type: %j', async ({ to }) => {
      const f = fixture();
      await expect(f.service.sendEstimateShare({ ...share(), to: to as unknown as string, cc: 'other@example.com' })).rejects.toThrow('valid recipient email');
      expect(sendMail).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    });

    it.each([
      { cc: 'invalid' }, { cc: 'other@example.com,invalid' }, { cc: ',other@example.com' },
      { cc: 'other@example.com,' }, { cc: 'other@example.com,,another@example.com' },
      { cc: 'other@example.com;another@example.com' }, { cc: 'other@example.com\r\nBcc: another@example.com' },
      { cc: 'other@example.com,\nanother@example.com' },
      { cc: Array.from({ length: 10 }, (_, index) => `customer${index}@example.com`).join(',') },
      { cc: `other@example.com${' '.repeat(4096)}` }, { cc: ' '.repeat(4097) },
      { cc: `${'a'.repeat(65)}@example.com` }, { cc: null }, { cc: 123 }, { cc: ['other@example.com'] },
    ])('rejects invalid CC before connecting or sending: %j', async ({ cc }) => {
      const f = fixture();
      await expect(f.service.sendEstimateShare({ ...share(), cc: cc as string })).rejects.toThrow('valid recipient email');
      expect(sendMail).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
    });

    it.each([undefined, '', ' ', 'CLIENT@EXAMPLE.COM, client@example.com'])(
      'omits CC when blank or containing only the primary recipient: %j', async cc => {
        const f = fixture();
        await expect(f.service.sendEstimateShare({ ...share(), cc })).resolves.toEqual({ sent: true });
        expect(sendMail).toHaveBeenCalledTimes(1);
        expect(sendMail.mock.calls[0][0].to).toBe(email);
        expect(sendMail.mock.calls[0][0]).not.toHaveProperty('cc');
      },
    );

    it('sends one message with the explicit To and nine deduplicated CC recipients', async () => {
      const f = fixture();
      const recipients = Array.from({ length: 10 }, (_, index) => `customer${index}@example.com`);
      sendMail.mockResolvedValue({ accepted: recipients.map(address => ({ address: address.toUpperCase() })) });
      await expect(f.service.sendEstimateShare({
        ...share(), to: ` ${recipients[0].toUpperCase()} `,
        cc: [...recipients.map(address => ` ${address.toUpperCase()} `), recipients[1]].join(','),
      })).resolves.toEqual({ sent: true });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0].to).toBe(recipients[0]);
      expect(sendMail.mock.calls[0][0].cc).toEqual(recipients.slice(1));
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
    });

    it('returns only requested normalized addresses for a partial acceptance without provider details', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({
        accepted: [email.toUpperCase(), { name: 'Private name', address: email }, 'outsider@example.com'],
        rejected: [{ address: 'REJECTED@EXAMPLE.COM' }, 'private@example.com'],
        response: 'private SMTP details fake-notifications-secret',
        rejectedErrors: [new Error('provider failure with private details')],
      });
      await expect(f.service.sendEstimateShare({
        ...share(), to: ` ${email.toUpperCase()} `, cc: `rejected@example.com, unknown@example.com, ${email}`,
      })).resolves.toEqual({
        sent: false, accepted: [email], rejected: ['rejected@example.com'], unconfirmed: ['unknown@example.com'],
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
    });

    it('reports confirmed rejection separately without retrying or changing To and CC', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: [email], rejected: ['other@example.com'] });
      await expect(f.service.sendEstimateShare({ ...share(), cc: 'other@example.com' })).resolves.toEqual({
        sent: false, accepted: [email], rejected: ['other@example.com'], unconfirmed: [],
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0]).toMatchObject({ to: email, cc: ['other@example.com'] });
    });

    it('gives explicit rejections precedence over conflicting SMTP acceptances in a partial result', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: [email, 'other@example.com'], rejected: [{ address: 'OTHER@EXAMPLE.COM' }] });
      await expect(f.service.sendEstimateShare({ ...share(), cc: 'other@example.com' })).resolves.toEqual({
        sent: false, accepted: [email], rejected: ['other@example.com'], unconfirmed: [],
      });
    });

    it('keeps the primary recipient in To when only CC was accepted', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: ['other@example.com'], rejected: [email] });
      await expect(f.service.sendEstimateShare({ ...share(), cc: 'other@example.com' })).resolves.toEqual({
        sent: false, accepted: ['other@example.com'], rejected: [email], unconfirmed: [],
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0]).toMatchObject({ to: email, cc: ['other@example.com'] });
    });

    it('requires checking ambiguous recipients before resending when no recipient is confirmed accepted', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: ['outside-request@example.com'], rejected: ['other@example.com'] });
      await expect(f.service.sendEstimateShare({ ...share(), cc: 'other@example.com' })).rejects.toThrow(
        'Check whether the recipients received it before resending.',
      );
      expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it('reports total rejection when all requested recipients are rejected', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ rejected: [email, { address: 'OTHER@EXAMPLE.COM' }] });
      await expect(f.service.sendEstimateShare({ ...share(), cc: 'other@example.com' })).rejects.toThrow('rejected the recipient');
      expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it('normalizes the recipient and accepts the SMTP address-object response', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: [{ name: 'Jane', address: email.toUpperCase() }] });
      await f.service.sendEstimateShare({ ...share(), to: ` ${email.toUpperCase()} ` });
      expect(sendMail.mock.calls[0][0].to).toBe(email);
    });

    it.each([undefined, 'invalid', 'owner@example.com\r\nBcc: b@example.com'])(
      'uses configured reply-to when owner reply-to is absent or invalid: %s', async (ownerEmail) => {
        const f = fixture();
        await f.service.sendEstimateShare({ ...share(), ownerEmail });
        expect(sendMail.mock.calls[0][0].replyTo).toBe('sales@example.com');
      },
    );

    it.each(['HOST', 'USER', 'PASS', 'FROM_EMAIL'])(
      'fails explicitly without password-reset fallback when notification %s is missing', async (key) => {
        const f = fixture();
        delete f.values[`NOTIFICATIONS_SMTP_${key}`];
        expect(() => f.service.assertEstimateShareReady()).toThrow('Estimate email is unavailable');
        await expect(f.service.sendEstimateShare(share())).rejects.toThrow('Estimate email is unavailable');
        expect(createTransport).not.toHaveBeenCalled();
        expect(f.config.get.mock.calls.some(([name]) => name.startsWith('SMTP_'))).toBe(false);
      },
    );

    describe('configured public origin and delivery environment', () => {
      it.each([
        [undefined, 'http://192.168.1.139:3000'],
        ['development', 'http://localhost:3000'],
        ['test', 'http://[::1]:3000'],
        ['development', 'http://127.25.3.4:3100'],
        ['test', 'http://10.0.0.1:3000'],
        ['development', 'http://172.16.0.1:3000'],
        ['test', 'http://172.31.255.254:3000'],
      ])('never sends locally when NODE_ENV=%s and origin=%s', async (mode, origin) => {
        const f = fixture();
        if (mode === undefined) delete f.values.NODE_ENV;
        else f.values.NODE_ENV = mode;
        f.values.PUBLIC_FRONTEND_URL = origin!;

        await expect(f.service.sendEstimateShare(share())).rejects.toThrow('Estimate email is unavailable');
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();

        expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
        expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
        expect(f.db.notificationEmail.updateMany).not.toHaveBeenCalled();
        expect(f.row.status).toBe('PENDING');
        expect(sendMail).not.toHaveBeenCalled();
        expect(createTransport).not.toHaveBeenCalled();
        expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_') || key.startsWith('NOTIFICATIONS_SMTP_'))).toBe(false);
      });

      it.each(['production', 'staging'])(
        'rejects local HTTP in explicit %s environments for both email paths', async (mode) => {
          const f = fixture();
          f.values.NODE_ENV = mode;
          f.values.PUBLIC_FRONTEND_URL = 'http://192.168.1.139:3000';

          await expect(f.service.sendEstimateShare(share())).rejects.toThrow('Estimate email is unavailable');
          await f.service.enqueue(f.notification as never, f.db as never);
          await f.service.processPending();

          expect(createTransport).not.toHaveBeenCalled();
          expect(sendMail).not.toHaveBeenCalled();
          expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
          expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
        },
      );

      it.each([undefined, 'true'])('keeps HTTPS working for both email paths in production with EMAIL_DELIVERY_ENABLED=%s', async (enabled) => {
        const f = fixture();
        f.values.NODE_ENV = 'production';
        if (enabled !== undefined) f.values.EMAIL_DELIVERY_ENABLED = enabled;
        f.values.PUBLIC_FRONTEND_URL = 'https://portal.example.test:8443';

        await f.service.sendEstimateShare(share());
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();

        expect(sendMail).toHaveBeenCalledTimes(2);
        expect(sendMail.mock.calls[0][0].text).toContain('https://portal.example.test:8443/public/estimates/total_customer-token');
        expect(sendMail.mock.calls[1][0].text).toContain('https://portal.example.test:8443/orders/21');
        expect(f.row.status).toBe('ACCEPTED');
      });

      it.each([
        '',
        'http://portal.example.test:3000',
        'http://172.15.255.254:3000',
        'http://172.32.0.1:3000',
        'http://localhost.evil.test:3000',
        'http://192.168.1.139.evil.test:3000',
        'http://user:password@localhost:3000',
        'https://user:password@portal.example.test',
      ])('rejects missing, public HTTP, lookalike or credential-bearing origins in development: %s', async (origin) => {
        const f = fixture();
        f.values.NODE_ENV = 'development';
        f.values.PUBLIC_FRONTEND_URL = origin;

        await expect(f.service.sendEstimateShare(share())).rejects.toThrow('Estimate email is unavailable');
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();

        expect(sendMail).not.toHaveBeenCalled();
        expect(createTransport).not.toHaveBeenCalled();
        expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
        expect(f.db.notificationEmail.findMany).not.toHaveBeenCalled();
      });
    });

    it.each(['', 'http://portal.example.test', 'https://username:password@portal.example.test'])(
      'fails before sending when the public website URL is missing or invalid: %s', async (origin) => {
        const f = fixture();
        f.values.PUBLIC_FRONTEND_URL = origin;
        await expect(f.service.sendEstimateShare(share())).rejects.toThrow('Estimate email is unavailable');
        expect(createTransport).not.toHaveBeenCalled();
      },
    );

    it('reports transport failure without leaking SMTP details or silently queuing a retry', async () => {
      const f = fixture();
      sendMail.mockRejectedValue(new Error('private SMTP details fake-notifications-secret client@example.com'));
      await expect(f.service.sendEstimateShare(share())).rejects.toThrow(
        'The estimate email could not be sent. Check whether the recipients received it before resending.',
      );
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(f.db.notificationEmail.create).not.toHaveBeenCalled();
    });

    it('reports an explicitly rejected recipient even if the response also lists it as accepted', async () => {
      const f = fixture();
      sendMail.mockResolvedValue({ accepted: [email], rejected: [email] });
      await expect(f.service.sendEstimateShare(share())).rejects.toThrow('rejected the recipient');
    });

    it.each([undefined, {}, { accepted: [] }, { accepted: ['someoneelse@example.com'] }])(
      'does not report success when SMTP acceptance is unconfirmed: %s', async (info) => {
        const f = fixture();
        sendMail.mockResolvedValue(info);
        await expect(f.service.sendEstimateShare(share())).rejects.toThrow('did not confirm acceptance');
      },
    );
  });
});

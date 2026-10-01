import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { NotificationEmailService } from './notification-email.service';
import { MailService } from '@/mail/mail.service';

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

  it.each([
    ['client', null, true],
    ['dealer', 'EXTERNAL', true],
    ['dealer', null, true],
    ['dealer', 'INTERNAL', false],
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
        f.user.role.name = 'dealer';
        f.user.dealerMode = 'INTERNAL';
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
      await expect(f.service.sendEstimateShare(share())).resolves.toBeUndefined();
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

    it.each(['', 'invalid', 'a@example.com,b@example.com', 'a@example.com\r\nBcc: b@example.com'])(
      'rejects an invalid recipient without sending: %s', async (to) => {
        const f = fixture();
        await expect(f.service.sendEstimateShare({ ...share(), to })).rejects.toThrow('valid recipient email');
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

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

    describe('configured public origin for local development', () => {
      it.each([
        [undefined, 'http://192.168.1.139:3000'],
        ['development', 'http://localhost:3000'],
        ['test', 'http://[::1]:3000'],
        ['development', 'http://127.25.3.4:3100'],
        ['test', 'http://10.0.0.1:3000'],
        ['development', 'http://172.16.0.1:3000'],
        ['test', 'http://172.31.255.254:3000'],
      ])('uses local HTTP for both email paths when NODE_ENV=%s and origin=%s', async (mode, origin) => {
        const f = fixture();
        if (mode === undefined) delete f.values.NODE_ENV;
        else f.values.NODE_ENV = mode;
        f.values.PUBLIC_FRONTEND_URL = origin!;

        await expect(f.service.sendEstimateShare(share())).resolves.toBeUndefined();
        await f.service.enqueue(f.notification as never, f.db as never);
        await f.service.processPending();

        expect(f.db.notificationEmail.create).toHaveBeenCalledWith({
          data: { notificationId: 10, email },
        });
        expect(f.row.status).toBe('ACCEPTED');
        expect(sendMail).toHaveBeenCalledTimes(2);
        expect(sendMail.mock.calls[0][0].html).toContain(`href="${origin}${share().path}"`);
        expect(sendMail.mock.calls[1][0].html).toContain(`href="${origin}/orders/21"`);
        expect(createTransport).toHaveBeenCalledTimes(1);
        expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
          host: 'smtp.example.com', port: 465, secure: true,
          auth: { user: 'notifications@example.com', pass: 'fake-notifications-secret' },
        }));
        expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
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

      it('keeps HTTPS working for both email paths in production', async () => {
        const f = fixture();
        f.values.NODE_ENV = 'production';
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
        'The estimate email could not be sent. Please try again later.',
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

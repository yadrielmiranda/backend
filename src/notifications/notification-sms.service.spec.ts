import { Logger } from '@nestjs/common';
import axios from 'axios';
import { NotificationSmsService } from './notification-sms.service';

jest.mock('axios');
const post = jest.mocked(axios.post);
const account = `AC${'1'.repeat(32)}`;
const key = `SK${'2'.repeat(32)}`;
const messagingService = `MG${'3'.repeat(32)}`;
const messageSid = `SM${'4'.repeat(32)}`;
const phone = '+13055551234';
const acceptedAt = new Date('2026-09-08T12:00:00Z');

function recipient() {
  return {
    phone,
    isActive: true,
    deletedAt: null as Date | null,
    dealerMode: null as 'EXTERNAL' | 'INTERNAL' | null,
    role: { name: 'client' },
    smsConsent: {
      enabled: true,
      phone,
      consentedAt: acceptedAt,
      revokedAt: null as Date | null,
      consentVersion: 'version',
      consentText: 'accepted service notifications',
    },
  };
}

function fixture() {
  const user = recipient();
  const notification = {
    id: 10,
    recipientId: 7,
    message: 'Your order #190974 is ready.',
    actionUrl: '/orders/20',
    actionLabel: 'Open order',
    dedupeKey: 'order:20:ready',
    isRead: false,
    createdAt: new Date(),
    recipient: user,
  };
  const row = {
    notificationId: 10,
    phone,
    consentedAt: acceptedAt,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(),
    attemptedAt: null as Date | null,
    providerMessageSid: null as string | null,
    errorCode: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const values: Record<string, string> = {
    TWILIO_ACCOUNT_SID: account,
    TWILIO_API_KEY_SID: key,
    TWILIO_API_KEY_SECRET: 'fake-api-secret',
    TWILIO_AUTH_TOKEN: 'must-not-be-used-to-send',
    TWILIO_MESSAGING_SERVICE_SID: messagingService,
    PUBLIC_FRONTEND_URL: 'https://portal.example.test',
  };
  const config = { get: jest.fn((name: string) => values[name]) };
  const consent = {
    getProgram: jest.fn().mockResolvedValue({ companyName: 'Example Company' }),
    recordProviderChoice: jest.fn().mockResolvedValue(undefined),
  };
  const matches = (where: any) =>
    (!where.status || row.status === where.status) &&
    (!where.notificationId || where.notificationId === row.notificationId) &&
    (where.attempts === undefined || row.attempts === where.attempts) &&
    (!where.nextAttemptAt?.lte ||
      row.nextAttemptAt <= where.nextAttemptAt.lte) &&
    (!where.createdAt?.lt || row.createdAt < where.createdAt.lt) &&
    (!where.attemptedAt?.lt ||
      Boolean(row.attemptedAt && row.attemptedAt < where.attemptedAt.lt));
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    notification: { findUnique: jest.fn().mockResolvedValue(notification) },
    smsPhoneBlock: { findUnique: jest.fn().mockResolvedValue(null) },
    notificationSms: {
      create: jest.fn().mockResolvedValue(row),
      findMany: jest.fn(async ({ where }: any) =>
        matches(where) ? [{ ...row }] : [],
      ),
      // Simula las condiciones atómicas de updateMany, compartidas por dos workers.
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
    new NotificationSmsService(db as never, config as never, consent as never);
  return {
    db,
    user,
    notification,
    row,
    values,
    consent,
    service: createService(),
    createService,
  };
}

describe('NotificationSmsService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T13:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    post.mockResolvedValue({
      status: 201,
      data: { sid: messageSid, status: 'accepted' },
    } as never);
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
    ['unknown', null, false],
  ])('queues %s / %s only when eligible (%s)', async (role, mode, expected) => {
    const f = fixture();
    f.user.role.name = role as string;
    f.user.dealerMode = mode as typeof f.user.dealerMode;
    await f.service.enqueue(f.notification as never, f.db as never);
    expect(f.db.notificationSms.create).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    'missing',
    'disabled',
    'revoked',
    'unrecorded',
    'changed-phone',
    'invalid-phone',
    'inactive',
    'deleted',
    'blocked',
  ])('does not queue an ineligible recipient: %s', async (reason) => {
    const f = fixture();
    if (reason === 'missing') f.user.smsConsent = null as never;
    if (reason === 'disabled') f.user.smsConsent.enabled = false;
    if (reason === 'revoked') f.user.smsConsent.revokedAt = new Date();
    if (reason === 'unrecorded') f.user.smsConsent.consentedAt = null as never;
    if (reason === 'changed-phone') f.user.phone = '+13055559876';
    if (reason === 'invalid-phone')
      f.user.phone = f.user.smsConsent.phone = '3055551234';
    if (reason === 'inactive') f.user.isActive = false;
    if (reason === 'deleted') f.user.deletedAt = new Date();
    if (reason === 'blocked')
      f.db.smsPhoneBlock.findUnique.mockResolvedValue({ phone } as never);
    await f.service.enqueue(f.notification as never, f.db as never);
    expect(f.db.notificationSms.create).not.toHaveBeenCalled();
  });

  it.each([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_MESSAGING_SERVICE_SID',
  ])('keeps SMS disabled without %s', async (name) => {
    const f = fixture();
    delete f.values[name];
    await f.service.enqueue(f.notification as never, f.db as never);
    await f.service.processPending();
    expect(f.db.notificationSms.create).not.toHaveBeenCalled();
    expect(f.db.notificationSms.findMany).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('uses the transaction supplied to enqueue and stores the exact phone/consent snapshot', async () => {
    const f = fixture();
    const tx = { ...f.db, notificationSms: { create: jest.fn() } };
    await f.service.enqueue(f.notification as never, tx as never);
    expect(tx.notificationSms.create).toHaveBeenCalledWith({
      data: { notificationId: 10, phone, consentedAt: acceptedAt },
    });
    expect(f.db.notificationSms.create).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends through the Messaging Service with API key credentials and saves acceptance', async () => {
    const f = fixture();
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, options] = post.mock.calls[0];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`,
    );
    const params = new URLSearchParams(body as string);
    expect(params.get('To')).toBe(phone);
    expect(params.get('MessagingServiceSid')).toBe(messagingService);
    expect(params.get('From')).toBeNull();
    expect(params.get('Body')).toBe(
      'Example Company: Your order #190974 is ready.\nReply STOP to unsubscribe.',
    );
    expect(options?.auth).toEqual({
      username: key,
      password: 'fake-api-secret',
    });
    expect(options?.maxRedirects).toBe(0);
    expect(options?.timeout).toBe(10000);
    expect(f.row.status).toBe('ACCEPTED');
    expect(f.row.providerMessageSid).toBe(messageSid);
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    'internal',
    'admin',
    'operator',
    'inactive',
    'deleted',
    'disabled',
    'changed-phone',
    'new-consent',
    'blocked',
  ])(
    'rechecks the recipient immediately before sending: %s',
    async (change) => {
      const f = fixture();
      if (change === 'internal') {
        f.user.role.name = 'dealer';
        f.user.dealerMode = 'INTERNAL';
      }
      if (change === 'admin' || change === 'operator')
        f.user.role.name = change;
      if (change === 'inactive') f.user.isActive = false;
      if (change === 'deleted') f.user.deletedAt = new Date();
      if (change === 'disabled') f.user.smsConsent.enabled = false;
      if (change === 'changed-phone')
        f.user.phone = f.user.smsConsent.phone = '+13055559876';
      if (change === 'new-consent') f.user.smsConsent.consentedAt = new Date();
      if (change === 'blocked')
        f.db.smsPhoneBlock.findUnique.mockResolvedValue({ phone } as never);
      await f.service.processPending();
      expect(post).not.toHaveBeenCalled();
      expect(f.row.status).toBe('SKIPPED');
    },
  );

  it('allows an external dealer to receive SMS', async () => {
    const f = fixture();
    f.user.role.name = 'dealer';
    f.user.dealerMode = 'EXTERNAL';
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not resend when two processes compete for the same notification', async () => {
    const f = fixture();
    await Promise.all([
      f.service.processPending(),
      f.createService().processPending(),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
  });

  it('does not start a second interval while this process is still sending', async () => {
    const f = fixture();
    await Promise.all([f.service.processPending(), f.service.processPending()]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('skips pending messages older than 24 hours', async () => {
    const f = fixture();
    f.row.createdAt = new Date('2026-09-06T13:00:00Z');
    await f.service.processPending();
    expect(post).not.toHaveBeenCalled();
    expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'EXPIRED' });
  });

  it('records interrupted attempts as uncertain after a restart instead of sending them twice', async () => {
    const f = fixture();
    f.row.status = 'SENDING';
    f.row.attemptedAt = acceptedAt;
    await f.service.processPending();
    expect(post).not.toHaveBeenCalled();
    expect(f.row).toMatchObject({
      status: 'UNKNOWN',
      errorCode: 'INTERRUPTED_ATTEMPT',
    });
  });

  it('backs off for HTTP 429 and stops after three attempts', async () => {
    const f = fixture();
    post.mockResolvedValue({ status: 429, data: { code: 20429 } } as never);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'PENDING', attempts: 1 });
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(Date.now() + 60_000));
    await f.service.processPending();
    expect(f.row.attempts).toBe(2);
    jest.setSystemTime(new Date(Date.now() + 120_000));
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(3);
    expect(f.row).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      errorCode: '20429',
    });
  });

  it('does not reclaim a delayed worker snapshot after another process schedules a retry', async () => {
    const f = fixture();
    const snapshot = { ...f.row };
    post.mockResolvedValue({ status: 429, data: { code: 20429 } } as never);
    await f.service.processPending();
    jest.setSystemTime(new Date(Date.now() + 60_000));
    f.db.notificationSms.findMany.mockResolvedValueOnce([snapshot]);
    await f.createService().processPending();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(2);
    expect(f.row.attempts).toBe(2);
  });

  it('does not resend after Twilio accepts a message but saving its result fails', async () => {
    const f = fixture();
    const update = f.db.notificationSms.updateMany.getMockImplementation()!;
    f.db.notificationSms.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'ACCEPTED')
        throw new Error('Storage unavailable');
      return update(args);
    });
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row.status).toBe('SENDING');
    jest.setSystemTime(new Date(Date.now() + 11 * 60_000));
    await f.createService().processPending();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row).toMatchObject({
      status: 'UNKNOWN',
      errorCode: 'INTERRUPTED_ATTEMPT',
    });
  });

  it.each([400, 401, 403])(
    'records HTTP %s as failed without automatic retries',
    async (status) => {
      const f = fixture();
      post.mockResolvedValue({ status, data: { code: 20003 } } as never);
      await f.service.processPending();
      await f.service.processPending();
      expect(post).toHaveBeenCalledTimes(1);
      expect(f.row.status).toBe('FAILED');
    },
  );

  it('synchronizes a provider opt-out rejection without fabricating a MessageSid', async () => {
    const f = fixture();
    post.mockResolvedValue({ status: 400, data: { code: 21610 } } as never);
    await f.service.processPending();
    expect(f.consent.recordProviderChoice).toHaveBeenCalledWith(
      phone,
      null,
      'STOP',
    );
    expect(f.row).toMatchObject({ status: 'FAILED', errorCode: '21610' });
  });

  it('does not retry ambiguous network failures or log secrets/phone/message', async () => {
    const f = fixture();
    post.mockRejectedValue(
      new Error(`secret: fake-api-secret ${phone} ${f.notification.message}`),
    );
    await f.service.processPending();
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row).toMatchObject({
      status: 'UNKNOWN',
      errorCode: 'NETWORK_ERROR',
    });
    const logs = JSON.stringify(
      (Logger.prototype.warn as jest.Mock).mock.calls,
    );
    expect(logs).not.toContain('fake-api-secret');
    expect(logs).not.toContain(phone);
    expect(logs).not.toContain(f.notification.message);
  });

  it.each([
    { status: 503, data: { code: 20500 } },
    { status: 201, data: {} },
  ])('does not retry an ambiguous provider response: %j', async (response) => {
    const f = fixture();
    post.mockResolvedValue(response as never);
    await f.service.processPending();
    await f.service.processPending();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.row.status).toBe('UNKNOWN');
  });

  it('does not record a failed provider message as accepted', async () => {
    const f = fixture();
    post.mockResolvedValue({
      status: 201,
      data: { sid: messageSid, status: 'failed', error_code: 30032 },
    } as never);
    await f.service.processPending();
    expect(f.row).toMatchObject({
      status: 'FAILED',
      providerMessageSid: messageSid,
      errorCode: '30032',
    });
  });

  it.each([
    '/orders/20',
    '//outside.example/phish',
    '/\\outside.example/phish',
    'https://outside.example/phish',
  ])(
    'omits action links from the SMS: %s',
    async (actionUrl) => {
      const f = fixture();
      f.notification.actionUrl = actionUrl;
      await f.service.processPending();
      const body = new URLSearchParams(post.mock.calls[0][1] as string).get(
        'Body',
      );
      expect(body).not.toContain('outside.example');
      expect(body).not.toContain('https://');
      expect(body).not.toContain('/orders/');
      expect(body).not.toContain('Open order');
    },
  );

  it('keeps the STOP instruction when shortening long text', async () => {
    const f = fixture();
    f.notification.message = 'a'.repeat(1000);
    await f.service.processPending();
    const body = new URLSearchParams(post.mock.calls[0][1] as string).get(
      'Body',
    );
    expect(body).toContain(
      '...\nReply STOP to unsubscribe.',
    );
    expect(body!.length).toBeLessThan(450);
  });
});

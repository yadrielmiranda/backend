import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { NotificationEmailService } from '@/notifications/notification-email.service';
import { WelcomeEmailService } from './welcome-email.service';
import { renderWelcomeEmail } from './welcome-email-template';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const createTransport = jest.mocked(nodemailer.createTransport);
const sendMail = jest.fn();
const address = 'shared@example.com';

const template = (roleName = 'client') => renderWelcomeEmail({
  firstName: 'Jordan', username: 'jordan', roleName,
  companyName: 'Authentic Evolution Co', origin: 'https://portal.example.test',
  supportEmail: 'sales@authenticevolutionco.com',
});

function deliveryFixture() {
  const values: Record<string, string> = {
    NOTIFICATIONS_SMTP_HOST: 'smtp.example.com', NOTIFICATIONS_SMTP_PORT: '465',
    NOTIFICATIONS_SMTP_SECURE: 'true', NOTIFICATIONS_SMTP_USER: 'notifications@example.com',
    NOTIFICATIONS_SMTP_PASS: 'fake-notifications-secret', NOTIFICATIONS_SMTP_FROM_EMAIL: 'notifications@example.com',
    NOTIFICATIONS_SMTP_FROM_NAME: 'Authentic Evolution Co', NOTIFICATIONS_SMTP_REPLY_TO: 'sales@authenticevolutionco.com',
    PUBLIC_FRONTEND_URL: 'https://portal.example.test', NODE_ENV: 'production',
    SMTP_FROM_EMAIL: 'no-reply@example.com', SMTP_USER: 'no-reply@example.com', SMTP_PASS: 'fake-reset-secret',
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  return { values, config, service: new NotificationEmailService({} as never, config as never) };
}

function queueFixture() {
  const user = {
    firstName: 'Jordan', username: 'jordan', email: address as string | null,
    contactEmail: null as string | null, isActive: true, deletedAt: null as Date | null,
    role: { name: 'client' },
  };
  const row = {
    userId: 7, email: address, status: 'PENDING', attempts: 0,
    nextAttemptAt: new Date(), attemptedAt: null as Date | null,
    providerMessageId: null as string | null, errorCode: null as string | null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const matches = (where: any) =>
    (!where.status || where.status === row.status) &&
    (!where.userId || where.userId === row.userId) &&
    (where.attempts === undefined || where.attempts === row.attempts) &&
    (!where.nextAttemptAt?.lte || row.nextAttemptAt <= where.nextAttemptAt.lte) &&
    (!where.createdAt?.lt || row.createdAt < where.createdAt.lt) &&
    (!where.attemptedAt?.lt || Boolean(row.attemptedAt && row.attemptedAt < where.attemptedAt.lt));
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    accountWelcomeEmail: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(async ({ where }: any) => matches(where) ? [{ ...row }] : []),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts?.increment) row.attempts += attempts.increment;
        if (attempts?.decrement) row.attempts -= attempts.decrement;
        return { count: 1 };
      }),
    },
  };
  const email = {
    canSendAccountWelcomeEmail: jest.fn().mockReturnValue(true),
    sendAccountWelcome: jest.fn().mockResolvedValue({ status: 'ACCEPTED', providerMessageId: '<welcome-id>' }),
  };
  const createService = () => new WelcomeEmailService(db as never, email as never);
  return { user, row, db, email, service: createService(), createService };
}

describe('welcome email', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T12:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    createTransport.mockReturnValue({ sendMail } as never);
    sendMail.mockResolvedValue({ accepted: [address], rejected: [], messageId: '<welcome-id>' });
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  describe('content', () => {
    it.each(['client', 'dealer'])('renders the approved %s welcome and contacts', role => {
      const mail = template(role);
      expect(mail.text).toContain(`Your ${role} account is ready.`);
      expect(mail.text).toContain('impact windows and doors');
      expect(mail.text).toContain('Start quoting: https://portal.example.test/login');
      for (const body of [mail.text, mail.html]) {
        expect(body).not.toContain('Your account details');
        expect(body).not.toContain('Account type:');
        expect(body).not.toContain('Username:');
        expect(body).not.toContain('jordan');
      }
      expect(mail.text).toContain('Forgot your password?');
      expect(mail.html).toContain('href="tel:+17869994224"');
      expect(mail.html).toContain('href="mailto:sales@authenticevolutionco.com"');
      expect(mail.html).toContain('src="https://portal.example.test/branding/authentic-login-logo.png"');
      expect(mail.text).not.toContain('Thank you for creating');
    });
    it('uses technician access and username without offering shared-email password recovery', () => {
      const mail = template('technician');
      expect(mail.text).toContain('https://portal.example.test/technician');
      expect(mail.text).toContain('Your technician account is ready.');
      for (const body of [mail.text, mail.html]) {
        expect(body).not.toContain('Your account details');
        expect(body).not.toContain('Account type:');
        expect(body).not.toContain('Username:');
        expect(body).not.toContain('jordan');
      }
      expect(mail.text).toContain('Sign in with your technician username.');
      expect(mail.text).toContain('contact your administrator');
      expect(mail.text).not.toContain('Forgot your password');
      expect(mail.text).not.toContain('Start quoting');
    });
    it.each(['admin', 'operator', 'warehouse'])('sends %s a generic account welcome', role => {
      const mail = template(role);
      expect(mail.text).toContain('Access portal: https://portal.example.test/login');
      expect(mail.text).toContain('workspace and tools available to your account');
      expect(mail.text).not.toContain('dealer network');
      for (const body of [mail.text, mail.html]) {
        expect(body).not.toContain('Your account details');
        expect(body).not.toContain('Account type:');
        expect(body).not.toContain('Username:');
        expect(body).not.toContain('jordan');
      }
    });
    it('escapes names and account data while keeping links on the configured origin', () => {
      const mail = renderWelcomeEmail({
        firstName: '<img src=x onerror=alert(1)>', username: 'a<&"b', roleName: '<script>x</script>',
        companyName: 'A & B\r\nBcc: nope', origin: 'https://portal.example.test/a/path?ignored=yes',
        supportEmail: 'sales@example.com',
      });
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(mail.html).not.toContain('a&lt;&amp;&quot;b');
      expect(mail.text).not.toContain('a<&"b');
      expect(mail.html).toContain('https://portal.example.test/login');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.text).not.toContain('ignored=yes');
    });
    it.each(['javascript:alert(1)', 'https://name:secret@example.com'])('rejects an invalid origin %s', origin => {
      expect(() => renderWelcomeEmail({ firstName: '', username: 'test', roleName: 'client',
        companyName: 'Company', origin, supportEmail: 'sales@example.com' })).toThrow();
    });
  });

  describe('notification SMTP', () => {
    const input = { to: address, firstName: 'Jordan', username: 'jordan', roleName: 'client' };
    it('uses notification credentials, correct sender and sales reply-to', async () => {
      const f = deliveryFixture();
      await expect(f.service.sendAccountWelcome(input)).resolves.toEqual({ status: 'ACCEPTED', providerMessageId: '<welcome-id>' });
      expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
        auth: { user: 'notifications@example.com', pass: 'fake-notifications-secret' },
        disableFileAccess: true, disableUrlAccess: true,
      }));
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        from: { name: 'Authentic Evolution Co', address: 'notifications@example.com' },
        replyTo: 'sales@authenticevolutionco.com', to: address,
      }));
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
      expect(JSON.stringify(sendMail.mock.calls)).not.toContain('fake-notifications-secret');
    });
    it('does not fall back to recovery SMTP when notification SMTP is missing', async () => {
      const f = deliveryFixture(); delete f.values.NOTIFICATIONS_SMTP_PASS;
      expect(f.service.canSendAccountWelcomeEmail()).toBe(false);
      await expect(f.service.sendAccountWelcome(input)).resolves.toEqual({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
      expect(sendMail).not.toHaveBeenCalled();
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
    });
    it('uses approved sales contact as fallback reply-to', async () => {
      const f = deliveryFixture(); delete f.values.NOTIFICATIONS_SMTP_REPLY_TO;
      await f.service.sendAccountWelcome(input);
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'sales@authenticevolutionco.com' }));
    });
    it.each([
      [451, 'RETRY', 'SMTP_451'], [550, 'FAILED', 'SMTP_550'], [undefined, 'UNKNOWN', 'SMTP_CONNECTION_ERROR'],
    ])('classifies SMTP failure %s safely', async (responseCode, status, errorCode) => {
      const f = deliveryFixture(); sendMail.mockRejectedValue({ responseCode });
      await expect(f.service.sendAccountWelcome(input)).resolves.toEqual({ status, errorCode });
    });
    it('rejects header-injection recipients before connecting', async () => {
      const f = deliveryFixture();
      await expect(f.service.sendAccountWelcome({ ...input, to: 'a@example.com\r\nBcc:b@example.com' }))
        .resolves.toEqual({ status: 'FAILED', errorCode: 'INVALID_RECIPIENT' });
      expect(sendMail).not.toHaveBeenCalled();
    });
    it('does not call an accepted message delivered, and treats missing provider acceptance as unknown', async () => {
      const f = deliveryFixture(); sendMail.mockResolvedValue({ accepted: [], rejected: [] });
      await expect(f.service.sendAccountWelcome(input)).resolves.toEqual({ status: 'UNKNOWN', errorCode: 'INVALID_SMTP_RESPONSE' });
    });
    it('prioritizes explicit recipient rejection over contradictory acceptance', async () => {
      const f = deliveryFixture(); sendMail.mockResolvedValue({ accepted: [address], rejected: [address] });
      await expect(f.service.sendAccountWelcome(input)).resolves.toEqual({ status: 'FAILED', errorCode: 'RECIPIENT_REJECTED' });
    });
  });

  describe('durable queue', () => {
    it.each(['client', 'dealer', 'admin', 'operator', 'warehouse'])('queues a %s only once per user, without sending inside the transaction', async role => {
      const f = queueFixture(); f.user.role.name = role;
      await f.service.enqueue(7, f.db as never);
      expect(f.db.accountWelcomeEmail.createMany).toHaveBeenCalledWith({ data: [{ userId: 7, email: address }], skipDuplicates: true });
      expect(f.email.sendAccountWelcome).not.toHaveBeenCalled();
      expect(f.email.canSendAccountWelcomeEmail).not.toHaveBeenCalled();
    });
    it('uses technician contact email and permits the same address for different account IDs', async () => {
      const f = queueFixture(); await f.service.enqueue(7, f.db as never);
      f.user.role.name = 'technician'; f.user.email = null; f.user.contactEmail = ' Shared@Example.com ';
      await f.service.enqueue(8, f.db as never);
      expect(f.db.accountWelcomeEmail.createMany).toHaveBeenNthCalledWith(2, { data: [{ userId: 8, email: address }], skipDuplicates: true });
      await f.service.processPending();
      expect(f.email.sendAccountWelcome).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'technician', to: address }));
    });
    it('does not substitute login email when a technician has no contact email', async () => {
      const f = queueFixture(); f.user.role.name = 'technician';
      await f.service.enqueue(7, f.db as never);
      expect(f.db.accountWelcomeEmail.createMany).not.toHaveBeenCalled();
    });
    it.each(['inactive', 'deleted', 'invalid', 'missing'])('does not queue a %s recipient', async reason => {
      const f = queueFixture();
      if (reason === 'inactive') f.user.isActive = false;
      if (reason === 'deleted') f.user.deletedAt = new Date();
      if (reason === 'invalid') f.user.email = 'invalid';
      if (reason === 'missing') f.db.user.findUnique.mockResolvedValue(null);
      await f.service.enqueue(7, f.db as never);
      expect(f.db.accountWelcomeEmail.createMany).not.toHaveBeenCalled();
    });
    it('sends a committed row and never sends an accepted row again', async () => {
      const f = queueFixture(); await f.service.processPending(); await f.service.processPending();
      expect(f.row.status).toBe('ACCEPTED'); expect(f.row.providerMessageId).toBe('<welcome-id>');
      expect(f.email.sendAccountWelcome).toHaveBeenCalledTimes(1);
    });
    it('allows only one worker to claim the row', async () => {
      const f = queueFixture(); await Promise.all([f.service.processPending(), f.createService().processPending()]);
      expect(f.email.sendAccountWelcome).toHaveBeenCalledTimes(1);
    });
    it.each(['changed', 'inactive', 'deleted'])('skips a %s account before sending', async reason => {
      const f = queueFixture();
      if (reason === 'changed') f.user.email = 'new@example.com';
      if (reason === 'inactive') f.user.isActive = false;
      if (reason === 'deleted') f.user.deletedAt = new Date();
      await f.service.processPending();
      expect(f.row.status).toBe('SKIPPED'); expect(f.row.errorCode).toBe('RECIPIENT_CHANGED');
      expect(f.email.sendAccountWelcome).not.toHaveBeenCalled();
    });
    it('preserves pending mail while notification SMTP is unavailable', async () => {
      const f = queueFixture(); f.email.canSendAccountWelcomeEmail.mockReturnValue(false);
      await f.service.processPending();
      expect(f.row.status).toBe('PENDING'); expect(f.db.accountWelcomeEmail.updateMany).not.toHaveBeenCalled();
      expect(f.email.sendAccountWelcome).not.toHaveBeenCalled();
    });
    it('returns a claimed row to pending without spending an attempt when configuration disappears', async () => {
      const f = queueFixture(); f.email.sendAccountWelcome.mockResolvedValue({ status: 'UNAVAILABLE', errorCode: 'EMAIL_NOT_CONFIGURED' });
      await f.service.processPending();
      expect(f.row.status).toBe('PENDING'); expect(f.row.attempts).toBe(0);
    });
    it('retries explicit temporary rejection with delay and caps at three attempts', async () => {
      const f = queueFixture(); f.email.sendAccountWelcome.mockResolvedValue({ status: 'RETRY', errorCode: 'SMTP_451' });
      await f.service.processPending();
      expect(f.row.status).toBe('PENDING'); expect(f.row.attempts).toBe(1);
      await f.service.processPending(); expect(f.email.sendAccountWelcome).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60_000); await f.service.processPending();
      jest.advanceTimersByTime(120_000); await f.service.processPending();
      expect(f.row.status).toBe('FAILED'); expect(f.row.attempts).toBe(3);
    });
    it.each(['UNKNOWN', 'FAILED'])('never retries a %s result', async status => {
      const f = queueFixture(); f.email.sendAccountWelcome.mockResolvedValue({ status, errorCode: 'TEST_ERROR' });
      await f.service.processPending(); jest.advanceTimersByTime(600_000); await f.service.processPending();
      expect(f.row.status).toBe(status); expect(f.email.sendAccountWelcome).toHaveBeenCalledTimes(1);
    });
    it('does not resend after a worker stopped while the SMTP result was uncertain', async () => {
      const f = queueFixture(); f.row.status = 'SENDING'; f.row.attemptedAt = new Date(Date.now() - 601_000);
      await f.service.processPending();
      expect(f.row.status).toBe('UNKNOWN'); expect(f.row.errorCode).toBe('INTERRUPTED_ATTEMPT');
      expect(f.email.sendAccountWelcome).not.toHaveBeenCalled();
    });
    it('expires old queued mail without creating new mail for existing users', async () => {
      const f = queueFixture(); f.row.createdAt = new Date(Date.now() - 86_400_001);
      await f.service.processPending();
      expect(f.row.status).toBe('SKIPPED'); expect(f.row.errorCode).toBe('EXPIRED');
      expect(f.db.accountWelcomeEmail.createMany).not.toHaveBeenCalled();
      expect(f.email.sendAccountWelcome).not.toHaveBeenCalled();
    });
  });
});

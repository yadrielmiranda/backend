import { Logger, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const createTransport = jest.mocked(nodemailer.createTransport);
const sendMail = jest.fn();

function fixture() {
  const values: Record<string, string> = {
    NODE_ENV: 'production',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'reset@example.com',
    SMTP_PASS: 'test-secret',
    SMTP_FROM_EMAIL: 'reset@example.com',
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  const db = {
    branding: { findFirst: jest.fn().mockResolvedValue({ name: 'Example Company' }) },
  };
  return { values, config, db, service: new MailService(config as never, db as never) };
}

const request = {
  to: 'customer@example.com',
  resetLink: 'https://portal.example.com/reset-password?token=test-token',
  expiresInMinutes: 30,
};

describe('password reset email delivery policy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    createTransport.mockReturnValue({ sendMail } as never);
    sendMail.mockResolvedValue({ accepted: [request.to] });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, 'development', 'test', 'staging'])(
    'does not read the database or create a mail transport outside production: %s',
    async environment => {
      const f = fixture();
      if (environment === undefined) delete f.values.NODE_ENV;
      else f.values.NODE_ENV = environment;
      f.values.EMAIL_DELIVERY_ENABLED = 'true';

      await expect(f.service.sendPasswordResetEmail(request)).rejects.toThrow(
        new ServiceUnavailableException('Email delivery is disabled in this environment.'),
      );
      expect(f.db.branding.findFirst).not.toHaveBeenCalled();
      expect(f.config.get.mock.calls.some(([key]) => key.startsWith('SMTP_'))).toBe(false);
      expect(createTransport).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['false', '', 'yes', 'TRUE'])(
    'does not send with a disabled or invalid production switch: %s',
    async setting => {
      const f = fixture();
      f.values.EMAIL_DELIVERY_ENABLED = setting;
      await expect(f.service.sendPasswordResetEmail(request)).rejects.toThrow(ServiceUnavailableException);
      expect(f.db.branding.findFirst).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'true'])(
    'keeps production email delivery with switch %s and creates its transport lazily',
    async setting => {
      const f = fixture();
      if (setting !== undefined) f.values.EMAIL_DELIVERY_ENABLED = setting;
      expect(createTransport).not.toHaveBeenCalled();
      await f.service.sendPasswordResetEmail(request);
      expect(createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com', port: 465, secure: true,
        auth: { user: 'reset@example.com', pass: 'test-secret' },
      });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        from: '"Example Company" <reset@example.com>',
        to: request.to,
        subject: 'Reset your password',
        text: expect.stringContaining(request.resetLink),
      }));
    },
  );

  it('does not reuse an existing transport after delivery is disabled', async () => {
    const f = fixture();
    await f.service.sendPasswordResetEmail(request);
    f.values.EMAIL_DELIVERY_ENABLED = 'false';
    await expect(f.service.sendPasswordResetEmail(request)).rejects.toThrow(ServiceUnavailableException);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(f.db.branding.findFirst).toHaveBeenCalledTimes(1);
  });
});

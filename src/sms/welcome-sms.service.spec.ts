import { Logger } from '@nestjs/common';
import { WelcomeSmsService } from './welcome-sms.service';
import { hasActiveServiceSmsConsent } from './sms-recipient-policy';

const phone = '+13055551234';
const sid = `SM${'1'.repeat(32)}`;

function fixture(withPending = true) {
  const user = {
    firstName: 'Jordan', phone, isActive: true, deletedAt: null as Date | null,
    role: { name: 'client' }, dealerMode: 'EXTERNAL',
    smsConsent: {
      enabled: true, phone, consentedAt: new Date('2026-11-18T12:00:00Z') as Date | null,
      revokedAt: null as Date | null, consentVersion: 'accepted-version' as string | null,
      consentText: 'Service SMS accepted' as string | null,
      promotionsEnabled: false,
    },
  };
  const row = {
    userId: 7, phone, consentedAt: user.smsConsent.consentedAt!, status: 'PENDING', attempts: 0,
    isDealerApproval: false,
    nextAttemptAt: new Date(), attemptedAt: null as Date | null,
    providerMessageSid: null as string | null, errorCode: null as string | null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const rows = new Map<number, typeof row>(withPending ? [[row.userId, row]] : []);
  const matches = (entry: typeof row, where: any) =>
    (!where.status || where.status === entry.status) &&
    (where.userId === undefined || where.userId === entry.userId) &&
    (where.attempts === undefined || where.attempts === entry.attempts) &&
    (!where.nextAttemptAt?.lte || entry.nextAttemptAt <= where.nextAttemptAt.lte) &&
    (!where.createdAt?.lt || entry.createdAt < where.createdAt.lt) &&
    (!where.attemptedAt?.lt || Boolean(entry.attemptedAt && entry.attemptedAt < where.attemptedAt.lt));
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    smsPhoneBlock: { findUnique: jest.fn().mockResolvedValue(null) },
    accountWelcomeSms: {
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const entry of data) {
          if (rows.has(entry.userId)) continue;
          rows.set(entry.userId, { ...row, ...entry });
          count++;
        }
        return { count };
      }),
      findMany: jest.fn(async ({ where }: any) => Array.from(rows.values())
        .filter(entry => matches(entry, where)).map(entry => ({ ...entry }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const entry of rows.values()) {
          if (!matches(entry, where)) continue;
          const { attempts, ...rest } = data;
          Object.assign(entry, rest);
          if (attempts?.increment) entry.attempts += attempts.increment;
          if (attempts?.decrement) entry.attempts -= attempts.decrement;
          count++;
        }
        return { count };
      }),
    },
  };
  const sms = {
    canSendAccountWelcomeSms: jest.fn().mockReturnValue(true),
    sendAccountWelcomeSms: jest.fn().mockResolvedValue({ status: 'ACCEPTED', providerMessageSid: sid }),
  };
  const createService = () => new WelcomeSmsService(db as never, sms as never);
  return { user, row, rows, db, sms, service: createService(), createService };
}

describe('welcome SMS outbox', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-18T12:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('sends one dealer approval welcome per account', async () => {
    const f = fixture(false);
    await f.service.enqueue(7, f.db as never, true);
    await f.service.enqueue(7, f.db as never, true);
    await f.service.processPending();
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledWith({ phone, firstName: 'Jordan', isDealerApproval: true });
  });

  it.each(['client', 'dealer', 'admin', 'operator', 'warehouse', 'technician'])(
    'queues an authorized %s account without sending inside the creation transaction', async role => {
      const f = fixture(false);
      f.user.role.name = role;
      f.user.dealerMode = 'INTERNAL';
      await f.service.enqueue(7, f.db as never);
      expect(f.db.accountWelcomeSms.createMany).toHaveBeenCalledWith({
        data: [{ userId: 7, phone, consentedAt: f.user.smsConsent.consentedAt, isDealerApproval: false }], skipDuplicates: true,
      });
      expect(f.rows.size).toBe(1);
      expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
    },
  );

  it('deduplicates by account while distinct accounts can share a phone', async () => {
    const f = fixture(false);
    await Promise.all([f.service.enqueue(7, f.db as never), f.service.enqueue(7, f.db as never)]);
    expect(f.rows.size).toBe(1);
    await f.service.enqueue(8, f.db as never);
    expect(f.rows.size).toBe(2);
    expect(f.rows.get(7)?.phone).toBe(f.rows.get(8)?.phone);
  });

  it('does not query or alter a restored outbox when SMS delivery is disabled', async () => {
    const f = fixture();
    f.row.status = 'SENDING';
    f.row.attemptedAt = new Date(Date.now() - 601_000);
    f.sms.canSendAccountWelcomeSms.mockReturnValue(false);
    await f.service.enqueue(7, f.db as never);
    await f.service.processPending();
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.smsPhoneBlock.findUnique).not.toHaveBeenCalled();
    for (const method of Object.values(f.db.accountWelcomeSms)) expect(method).not.toHaveBeenCalled();
    expect(f.row.status).toBe('SENDING');
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'deleted', 'missing', 'unsupported', 'consent-disabled', 'revoked',
    'consent-phone-changed', 'missing-date', 'missing-version', 'missing-text', 'promotions-only'])(
    'rejects %s consent at enqueue and before send', async reason => {
      const f = fixture();
      if (reason === 'inactive') f.user.isActive = false;
      if (reason === 'deleted') f.user.deletedAt = new Date();
      if (reason === 'missing') f.db.user.findUnique.mockResolvedValue(null);
      if (reason === 'unsupported') f.user.phone = '+442079460123';
      if (reason === 'consent-disabled') f.user.smsConsent.enabled = false;
      if (reason === 'revoked') f.user.smsConsent.revokedAt = new Date();
      if (reason === 'consent-phone-changed') f.user.smsConsent.phone = '+13055551235';
      if (reason === 'missing-date') f.user.smsConsent.consentedAt = null;
      if (reason === 'missing-version') f.user.smsConsent.consentVersion = null;
      if (reason === 'missing-text') f.user.smsConsent.consentText = null;
      if (reason === 'promotions-only') {
        f.user.smsConsent.enabled = false;
        f.user.smsConsent.promotionsEnabled = true;
      }
      expect(hasActiveServiceSmsConsent(reason === 'missing' ? null : f.user)).toBe(false);
      await f.service.enqueue(7, f.db as never);
      expect(f.db.accountWelcomeSms.createMany).not.toHaveBeenCalled();
      await f.service.processPending();
      expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'RECIPIENT_OR_CONSENT_CHANGED' });
      expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
    },
  );

  it('requires saved consent and never treats a missing consent record as permission', async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({ ...f.user, smsConsent: null });
    expect(hasActiveServiceSmsConsent({ ...f.user, smsConsent: null })).toBe(false);
    await f.service.enqueue(7, f.db as never);
    await f.service.processPending();
    expect(f.db.accountWelcomeSms.createMany).not.toHaveBeenCalled();
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
    expect(f.row.status).toBe('SKIPPED');
  });

  it('honors STOP both when queuing and before sending', async () => {
    const f = fixture();
    f.db.smsPhoneBlock.findUnique.mockResolvedValue({ phone });
    await f.service.enqueue(7, f.db as never);
    await f.service.processPending();
    expect(f.db.accountWelcomeSms.createMany).not.toHaveBeenCalled();
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
    expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'PROVIDER_STOP' });
  });

  it.each(['new-phone', 'new-consent'])('does not redirect an old welcome after %s', async reason => {
    const f = fixture();
    if (reason === 'new-phone') f.user.phone = f.user.smsConsent.phone = '+13055551235';
    else f.user.smsConsent.consentedAt = new Date(Date.now() + 1);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'RECIPIENT_OR_CONSENT_CHANGED' });
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
  });

  it('passes the first name to the single-segment sender and never resends an accepted welcome', async () => {
    const f = fixture();
    await f.service.processPending();
    await f.createService().processPending();
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledWith({ phone, firstName: 'Jordan', isDealerApproval: false });
    expect(f.row).toMatchObject({ status: 'ACCEPTED', providerMessageSid: sid, attempts: 1 });
    expect(f.db.accountWelcomeSms.createMany).not.toHaveBeenCalled();
  });

  it('allows only one worker to claim a welcome', async () => {
    const f = fixture();
    await Promise.all([f.service.processPending(), f.createService().processPending()]);
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
  });

  it('does not overlap the worker within the same process', async () => {
    const f = fixture();
    await Promise.all([f.service.processPending(), f.service.processPending()]);
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed row without spending an attempt if sending becomes unavailable', async () => {
    const f = fixture();
    f.sms.sendAccountWelcomeSms.mockResolvedValue({ status: 'UNAVAILABLE', errorCode: 'SMS_NOT_CONFIGURED' });
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'PENDING', attempts: 0, attemptedAt: null, errorCode: 'SMS_NOT_CONFIGURED' });
    expect(f.row.nextAttemptAt.getTime()).toBe(Date.now() + 60_000);
  });

  it('backs off after explicit temporary rejection and caps retries at three attempts', async () => {
    const f = fixture();
    f.sms.sendAccountWelcomeSms.mockResolvedValue({ status: 'RETRY', errorCode: '20429' });
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'PENDING', attempts: 1 });
    await f.service.processPending();
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await f.service.processPending();
    expect(f.row.attempts).toBe(2);
    jest.advanceTimersByTime(120_000);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'FAILED', attempts: 3, errorCode: '20429' });
  });

  it('rejects a stale worker snapshot after another attempt has scheduled a retry', async () => {
    const f = fixture();
    const snapshot = { ...f.row };
    f.sms.sendAccountWelcomeSms.mockResolvedValue({ status: 'RETRY', errorCode: '20429' });
    await f.service.processPending();
    jest.advanceTimersByTime(60_000);
    f.db.accountWelcomeSms.findMany.mockResolvedValueOnce([snapshot]);
    await f.createService().processPending();
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
    expect(f.row.attempts).toBe(1);
    await f.service.processPending();
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(2);
  });

  it.each(['UNKNOWN', 'FAILED'])('does not automatically resend a %s result', async status => {
    const f = fixture();
    f.sms.sendAccountWelcomeSms.mockResolvedValue({ status, errorCode: 'TEST_FAILURE', providerMessageSid: sid });
    await f.service.processPending();
    jest.advanceTimersByTime(600_000);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status, errorCode: 'TEST_FAILURE', providerMessageSid: sid });
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
  });

  it('marks interrupted attempts as uncertain without resending', async () => {
    const f = fixture();
    f.row.status = 'SENDING';
    f.row.attemptedAt = new Date(Date.now() - 601_000);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' });
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
  });

  it('does not resend when the provider accepted a welcome but saving the result failed', async () => {
    const f = fixture();
    const original = f.db.accountWelcomeSms.updateMany.getMockImplementation()!;
    f.db.accountWelcomeSms.updateMany.mockImplementation(async args => {
      if (args.data.status === 'ACCEPTED') throw new Error('Storage unavailable');
      return original(args);
    });
    await f.service.processPending();
    expect(f.row.status).toBe('SENDING');
    jest.advanceTimersByTime(601_000);
    await f.createService().processPending();
    expect(f.row).toMatchObject({ status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' });
    expect(f.sms.sendAccountWelcomeSms).toHaveBeenCalledTimes(1);
  });

  it('expires old pending welcomes without scanning or creating messages for existing accounts', async () => {
    const f = fixture();
    f.row.createdAt = new Date(Date.now() - 86_400_001);
    await f.service.processPending();
    expect(f.row).toMatchObject({ status: 'SKIPPED', errorCode: 'EXPIRED' });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.accountWelcomeSms.createMany).not.toHaveBeenCalled();
    expect(f.sms.sendAccountWelcomeSms).not.toHaveBeenCalled();
  });

  it('does not log personal information when a send throws unexpectedly', async () => {
    const f = fixture();
    f.sms.sendAccountWelcomeSms.mockRejectedValue(new Error(`private details ${phone} Jordan`));
    await f.service.processPending();
    const logs = JSON.stringify((Logger.prototype.error as jest.Mock).mock.calls);
    expect(logs).toContain('account #7');
    expect(logs).not.toContain(phone);
    expect(logs).not.toContain('Jordan');
    expect(f.row.status).toBe('SENDING');
  });
});

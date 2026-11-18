import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { deliverSms, type SmsDeliveryResult } from '@/sms/sms-transport';
import { EstimateShareSmsService, normalizeEstimateSmsPhone } from './estimate-share-sms.service';

jest.mock('@/sms/sms-transport', () => ({ deliverSms: jest.fn() }));
const deliver = jest.mocked(deliverSms);
const phone = '+13055551234';
const account = `AC${'1'.repeat(32)}`;
const key = `SK${'2'.repeat(32)}`;
const messagingService = `MG${'3'.repeat(32)}`;
const messageSid = `SM${'4'.repeat(32)}`;
const request = { phone, path: '/public/estimates/detailed_token', estimateNumber: '191165', customerName: 'Sara Perez' };

function fixture() {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    SMS_DELIVERY_ENABLED: 'true',
    PUBLIC_FRONTEND_URL: 'https://portal.example.test',
    TWILIO_ACCOUNT_SID: account,
    TWILIO_API_KEY_SID: key,
    TWILIO_API_KEY_SECRET: 'fake-secret',
    TWILIO_MESSAGING_SERVICE_SID: messagingService,
  };
  const config = { get: jest.fn((name: string) => values[name]) };
  const db = {
    smsPhoneBlock: {
      findUnique: jest.fn(async (_query: unknown) => null as { phone: string } | null),
      upsert: jest.fn(async (_query: unknown) => ({ phone })),
    },
    branding: { findFirst: jest.fn(async (_query: unknown) => ({ name: 'Authentic Evolution Co' } as { name: string } | null)) },
    user: { findUnique: jest.fn(() => { throw new Error('Explicit sharing must not require an account.'); }) },
    smsConsent: {
      findUnique: jest.fn(() => { throw new Error('Explicit sharing must not read account preferences.'); }),
      upsert: jest.fn(), update: jest.fn(),
    },
    notification: { create: jest.fn() }, notificationSms: { create: jest.fn() },
  };
  const service = new EstimateShareSmsService(db as never, config as never);
  return { values, config, db, service };
}

beforeEach(() => {
  deliver.mockReset();
  deliver.mockResolvedValue({ status: 'ACCEPTED', providerMessageSid: messageSid });
});

describe('Explicit estimate SMS sharing', () => {
  it.each(['(305) 555-1234', '3055551234', '1 (305) 555-1234', '+1 305 555 1234'])
  ('normalizes the complete recipient number %s', async value => {
    expect(normalizeEstimateSmsPhone(value)).toBe(phone);
    const f = fixture();
    expect(await f.service.assertReady(value)).toBe(phone);
    expect(f.db.smsPhoneBlock.findUnique).toHaveBeenCalledWith({ where: { phone } });
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 3055551234, '', 'not a phone', 'Call +13055551234', '+13055551234 ext 2', '+13055551234,+17865551234', '+442079460123', '+12005551234', '+1305555123', '5'.repeat(81)])
  ('rejects invalid or unsupported phone input %p without delivery', async value => {
    expect(normalizeEstimateSmsPhone(value)).toBeNull();
    const f = fixture();
    await expect(f.service.send({ ...request, phone: value as string })).rejects.toThrow(BadRequestException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('sends a guest recipient the exact public estimate link without reading or changing account SMS preferences', async () => {
    const f = fixture();
    await expect(f.service.send({ ...request, phone: '(305) 555-1234', ownerBrandingName: 'Different dealer brand' })).resolves.toEqual({ status: 'sent' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      { account, key, secret: 'fake-secret', service: messagingService }, phone,
      'Authentic Evolution Co: Hi Sara, your estimate #191165 is ready. View it here: https://portal.example.test/public/estimates/detailed_token\nReply STOP to unsubscribe.',
    );
    expect(f.db.branding.findFirst).toHaveBeenCalledWith({ where: { type: 'COMPANY', isActive: true }, select: { name: true } });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.smsConsent.findUnique).not.toHaveBeenCalled();
    expect(f.db.smsConsent.upsert).not.toHaveBeenCalled();
    expect(f.db.smsConsent.update).not.toHaveBeenCalled();
    expect(f.db.notification.create).not.toHaveBeenCalled();
    expect(f.db.notificationSms.create).not.toHaveBeenCalled();
  });

  it.each(['total_token', 'detailed_token'])('preserves the chosen %s route and full contract link', async token => {
    const f = fixture();
    const path = `/public/estimates/${token}/agreements/quote-uuid`;
    await f.service.send({ ...request, path });
    expect(deliver.mock.calls[0][2]).toContain(`View it here: https://portal.example.test${path}\nReply STOP`);
  });

  it('does not truncate a long link when limiting sender and customer text', async () => {
    const f = fixture();
    f.db.branding.findFirst.mockResolvedValue({ name: 'Company'.repeat(50) });
    const path = `/public/estimates/${'token_'.repeat(40)}/agreements/${'agreement_'.repeat(20)}`;
    await f.service.send({ ...request, path, customerName: 'Longname'.repeat(30) });
    const body = deliver.mock.calls[0][2];
    expect(body).toContain(`https://portal.example.test${path}\nReply STOP to unsubscribe.`);
    expect(body.split(': ')[0].length).toBeLessThanOrEqual(60);
    expect(body.match(/Hi (.*?), your/)?.[1].length).toBeLessThanOrEqual(32);
  });

  it('uses the company fallback and omits an empty greeting name', async () => {
    const f = fixture(); f.db.branding.findFirst.mockResolvedValue(null);
    await f.service.send({ ...request, customerName: null });
    expect(deliver.mock.calls[0][2]).toMatch(/^Authentic Evolution Co: Your estimate #191165 is ready\./);
  });

  it('normalizes whitespace and control characters in text fields', async () => {
    const f = fixture(); f.db.branding.findFirst.mockResolvedValue({ name: '  Authentic\r\nEvolution\u202e Co  ' });
    await f.service.send({ ...request, customerName: '\nSara\tPerez', estimateNumber: '  191165\r\n' });
    expect(deliver.mock.calls[0][2]).toMatch(/^Authentic Evolution Co: Hi Sara, your estimate #191165 is ready\./);
  });

  it.each(['development', 'test', '', undefined])('blocks real delivery in environment %p even with production credentials and enabled flag', async environment => {
    const f = fixture(); f.values.NODE_ENV = environment;
    await expect(f.service.assertReady(phone)).rejects.toThrow(ServiceUnavailableException);
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
    expect(f.db.smsPhoneBlock.findUnique).not.toHaveBeenCalled();
  });

  it.each(['false', '', 'TRUE', '1'])('honors explicit delivery flag %p', async enabled => {
    const f = fixture(); f.values.SMS_DELIVERY_ENABLED = enabled;
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('retains the production default when the optional delivery flag is absent', async () => {
    const f = fixture(); delete f.values.SMS_DELIVERY_ENABLED;
    await expect(f.service.send(request)).resolves.toEqual({ status: 'sent' });
  });

  it.each(['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_MESSAGING_SERVICE_SID'])('rejects missing %s without delivering', async field => {
    const f = fixture(); f.values[field] = '';
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_MESSAGING_SERVICE_SID'])('rejects a malformed %s without delivering', async field => {
    const f = fixture(); f.values[field] = 'invalid';
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(['http://192.168.1.139:3000', 'not a URL', 'https://user:secret@example.test', 'javascript:alert(1)', ''])('rejects unsafe public origin %p', async origin => {
    const f = fixture(); f.values.PUBLIC_FRONTEND_URL = origin;
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('uses the configured public origin rather than its path, query or alternate frontend domain', async () => {
    const f = fixture();
    f.values.PUBLIC_FRONTEND_URL = 'https://canonical.example.test:8443/base?ignored=true';
    f.values.FRONTEND_URL = 'https://different.example.test';
    await f.service.send(request);
    expect(deliver.mock.calls[0][2]).toContain('https://canonical.example.test:8443/public/estimates/detailed_token\n');
    expect(deliver.mock.calls[0][2]).not.toContain('different.example.test');
  });

  it('can use the trusted frontend URL when the public override is absent', async () => {
    const f = fixture(); delete f.values.PUBLIC_FRONTEND_URL; f.values.FRONTEND_URL = 'https://configured.example.test';
    await f.service.send(request);
    expect(deliver.mock.calls[0][2]).toContain('https://configured.example.test/public/estimates/detailed_token\n');
  });

  it.each(['https://evil.test/public/estimates/a', '//evil.test/public/estimates/a', '/orders/5', '/public/estimates/a?next=https://evil.test', '/public/estimates/../admin', '/public/estimates/a/agreements/', '/public/estimates/a#fragment', '/public/estimates/a\nignored', '/public/estimates/a\n', '/public/estimates/a%2Fextra'])
  ('rejects an invalid report path %p without sending', async path => {
    const f = fixture(); await expect(f.service.send({ ...request, path })).rejects.toThrow(BadRequestException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rechecks a STOP recorded after initial preparation and before sending', async () => {
    const f = fixture(); await f.service.assertReady(phone);
    f.db.smsPhoneBlock.findUnique.mockResolvedValue({ phone });
    await expect(f.service.send(request)).rejects.toThrow(ConflictException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rechecks environment changes between preparation and sending', async () => {
    const f = fixture(); await f.service.assertReady(phone);
    f.values.SMS_DELIVERY_ENABLED = 'false';
    await expect(f.service.send(request)).rejects.toThrow(ServiceUnavailableException);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('records a provider STOP against the phone only without modifying account preferences', async () => {
    const f = fixture(); deliver.mockResolvedValue({ status: 'FAILED', errorCode: '21610' });
    await expect(f.service.send(request)).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('reply START') });
    expect(f.db.smsPhoneBlock.upsert).toHaveBeenCalledWith({ where: { phone }, create: { phone }, update: { createdAt: expect.any(Date) } });
    expect(f.db.smsConsent.update).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'UNKNOWN', errorCode: 'NETWORK_ERROR' }, 'unknown'],
    [{ status: 'UNKNOWN', errorCode: 'HTTP_503' }, 'unknown'],
    [{ status: 'UNKNOWN', errorCode: 'INVALID_PROVIDER_RESPONSE' }, 'unknown'],
    [{ status: 'RETRY', errorCode: '20429' }, 'failed'],
    [{ status: 'FAILED', errorCode: '21614' }, 'failed'],
    [{ status: 'UNAVAILABLE', errorCode: 'SMS_UNAVAILABLE' }, 'failed'],
  ] as Array<[SmsDeliveryResult, 'failed' | 'unknown']>)('returns the appropriate result for %p without retrying', async (result, status) => {
    const f = fixture(); deliver.mockResolvedValue(result);
    const outcome = await f.service.send(request);
    expect(outcome.status).toBe(status);
    expect(outcome.message).not.toContain(result.status === 'ACCEPTED' ? '' : result.errorCode);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(f.db.smsPhoneBlock.upsert).not.toHaveBeenCalled();
  });

  it('does not retry or expose unexpected transport exceptions', async () => {
    const f = fixture(); deliver.mockRejectedValue(new Error('fake-secret and provider details'));
    await expect(f.service.send(request)).resolves.toEqual({ status: 'unknown', message: expect.stringContaining('Check whether it arrived') });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

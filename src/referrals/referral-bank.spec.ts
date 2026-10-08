import { BadRequestException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReferralBankCipher, validateReferralBank } from './referral-bank';
import { RecoverReferralPayoutDto, SaveReferralBankDto, SaveReferralProfileDto, TransitionReferralPayoutDto } from './referrals.dto';

const input = { holderName: 'Test Person', holderType: 'PERSONAL', bankName: 'Test Bank', accountType: 'CHECKING',
  routingNumber: '021000021', accountNumber: '00123456789', confirmAccountNumber: '00123456789', authorized: true };
const cipher = () => new ReferralBankCipher(new ConfigService({ REFERRAL_BANK_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') }));

describe('referral ACH bank protection', () => {
  it('preserves leading zeros and validates the ACH checksum', () => {
    expect(validateReferralBank(input)).toMatchObject({ routingNumber: '021000021', accountNumber: '00123456789', country: 'US', currency: 'USD' });
    expect(() => validateReferralBank({ ...input, routingNumber: '021000022' })).toThrow(BadRequestException);
    expect(() => validateReferralBank({ ...input, routingNumber: '000000000' })).toThrow(BadRequestException);
    expect(() => validateReferralBank({ ...input, confirmAccountNumber: '123456789' })).toThrow(BadRequestException);
    expect(() => validateReferralBank({ ...input, accountNumber: '0'.repeat(18) })).toThrow(BadRequestException);
    expect(() => validateReferralBank({ ...input, authorized: 'true' })).toThrow(BadRequestException);
  });

  it('uses authenticated encryption with a distinct destination context and random nonce', () => {
    const bank = validateReferralBank(input);
    const service = cipher();
    const first = service.encrypt(bank, 'profile:3');
    const second = service.encrypt(bank, 'profile:3');
    expect(first).not.toBe(second);
    expect(first).not.toContain(bank.accountNumber);
    expect(service.decrypt(first, 'profile:3')).toEqual(bank);
    expect(() => service.decrypt(first, 'profile:4')).toThrow(ServiceUnavailableException);
    const parts = first.split('.');
    parts[3] = Buffer.from('modified').toString('base64');
    expect(() => service.decrypt(parts.join('.'), 'profile:3')).toThrow(ServiceUnavailableException);
    const payout = service.encrypt(bank, 'payout:3:test');
    expect(() => service.decrypt(payout, 'profile:3')).toThrow(ServiceUnavailableException);
  });

  it('fails closed when the encryption key is unavailable', () => {
    const service = new ReferralBankCipher(new ConfigService({ REFERRAL_BANK_ENCRYPTION_KEY: '' }));
    expect(() => service.encrypt(validateReferralBank(input), 'profile:3')).toThrow(ServiceUnavailableException);
  });

  it('rejects coerced financial and consent values under the application validation settings', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
    const check = (value: any, metatype: any) => pipe.transform(value, { type: 'body', metatype });
    await expect(check(input, SaveReferralBankDto)).resolves.toMatchObject({ accountNumber: '00123456789' });
    await expect(check({ ...input, accountNumber: 123456789, confirmAccountNumber: 123456789 }, SaveReferralBankDto)).rejects.toThrow(BadRequestException);
    await expect(check({ ...input, authorized: 'true' }, SaveReferralBankDto)).rejects.toThrow(BadRequestException);
    await expect(check({ enabled: 'false', mode: 'CUSTOM_PERCENT', percent: '20' }, SaveReferralProfileDto)).rejects.toThrow(BadRequestException);
    await expect(check({ status: 'FAILED', confirmedNotSent: 'true', note: 'test' }, TransitionReferralPayoutDto)).rejects.toThrow(BadRequestException);
    await expect(check({ status: 'FAILED', expectedProcessingById: '1', bankOutcomeConfirmed: true }, RecoverReferralPayoutDto)).rejects.toThrow(BadRequestException);
    await expect(check({ status: 'FAILED', expectedProcessingById: 1, bankOutcomeConfirmed: 'true' }, RecoverReferralPayoutDto)).rejects.toThrow(BadRequestException);
  });
});

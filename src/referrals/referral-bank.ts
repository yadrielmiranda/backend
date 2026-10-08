import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type ReferralBankDetails = {
  holderName: string; holderType: 'PERSONAL' | 'BUSINESS'; bankName: string;
  accountType: 'CHECKING' | 'SAVINGS'; routingNumber: string; accountNumber: string;
  country: 'US'; currency: 'USD';
};

export function validateReferralBank(input: any): ReferralBankDetails {
  const holderName = typeof input.holderName === 'string' ? input.holderName.trim() : '';
  const bankName = typeof input.bankName === 'string' ? input.bankName.trim() : '';
  const routingNumber = typeof input.routingNumber === 'string' ? input.routingNumber.trim() : '';
  const accountNumber = typeof input.accountNumber === 'string' ? input.accountNumber.trim() : '';
  if (!holderName || holderName.length > 150 || !bankName || bankName.length > 100)
    throw new BadRequestException('Enter the account holder and bank name.');
  if (!['PERSONAL', 'BUSINESS'].includes(input.holderType) || !['CHECKING', 'SAVINGS'].includes(input.accountType))
    throw new BadRequestException('Choose a valid account holder and account type.');
  const routingDigits = [...routingNumber].map(Number);
  const prefix = Number(routingNumber.slice(0, 2));
  const checksum = routingDigits.reduce((sum, digit, i) => sum + digit * [3, 7, 1][i % 3], 0);
  if (!/^\d{9}$/.test(routingNumber) || /^0+$/.test(routingNumber) ||
      !((prefix >= 0 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80) || checksum % 10 !== 0)
    throw new BadRequestException('Enter a valid nine-digit ACH routing number.');
  if (!/^\d{1,17}$/.test(accountNumber) || /^0+$/.test(accountNumber))
    throw new BadRequestException('Enter a bank account number with 1 to 17 digits.');
  if (typeof input.confirmAccountNumber !== 'string' || input.confirmAccountNumber.trim() !== accountNumber)
    throw new BadRequestException('The account numbers do not match.');
  if (input.authorized !== true)
    throw new BadRequestException('Confirm that you are authorized to receive payments in this account.');
  return { holderName, holderType: input.holderType, bankName, accountType: input.accountType,
    routingNumber, accountNumber, country: 'US', currency: 'USD' };
}

@Injectable()
export class ReferralBankCipher {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const value = this.config.get<string>('REFERRAL_BANK_ENCRYPTION_KEY') ?? '';
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value)
      throw new ServiceUnavailableException('Bank payout setup is not available. Contact the administrator.');
    return key;
  }

  encrypt(details: ReferralBankDetails, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`referral-bank:v1:${context}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  decrypt(encrypted: string, context: string): ReferralBankDetails {
    const key = this.key();
    try {
      const [version, nonce, tag, ciphertext, extra] = encrypted.split('.');
      if (version !== 'v1' || extra !== undefined) throw new Error('Invalid envelope');
      const iv = Buffer.from(nonce, 'base64');
      const authTag = Buffer.from(tag, 'base64');
      if (iv.length !== 12 || authTag.length !== 16) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`referral-bank:v1:${context}`));
      decipher.setAuthTag(authTag);
      const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      if (decoded.country !== 'US' || decoded.currency !== 'USD' || typeof decoded.accountNumber !== 'string' || typeof decoded.routingNumber !== 'string')
        throw new Error('Invalid bank details');
      return decoded;
    } catch {
      throw new ServiceUnavailableException('The saved bank details could not be opened. Contact the administrator.');
    }
  }
}

import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrandingType } from '@prisma/client';
import { normalizePhoneToE164 } from '@/common/phone';
import { PrismaService } from '@/prisma/prisma.service';
import { isSmsDeliveryEnabled } from '@/sms/sms-delivery-policy';
import { supportsSmsPhone } from '@/sms/sms-phone-support';
import { deliverSms, type SmsSettings } from '@/sms/sms-transport';

export type EstimateShareSms = {
  phone: string;
  path: string;
  estimateNumber: string | number;
  customerName?: string | null;
  ownerBrandingName?: string | null;
};

export type EstimateShareSmsResult = {
  status: 'sent' | 'failed' | 'unknown';
  message?: string;
};

export function normalizeEstimateSmsPhone(value: unknown): string | null {
  const phone = normalizePhoneToE164(value);
  return supportsSmsPhone(phone) ? phone : null;
}

const cleanText = (value: string) => value.replace(/[\p{C}\s]+/gu, ' ').trim();
const excerpt = (value: string, length: number) => Array.from(cleanText(value)).slice(0, length).join('').trim();

/** Explicit estimate sharing is independent of recurring account SMS preferences. */
@Injectable()
export class EstimateShareSmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private settings(): SmsSettings & { origin: string } {
    if (!isSmsDeliveryEnabled(this.config)) {
      throw new ServiceUnavailableException('Estimate SMS is unavailable in this environment.');
    }
    const account = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ?? '';
    const key = this.config.get<string>('TWILIO_API_KEY_SID')?.trim() ?? '';
    const secret = this.config.get<string>('TWILIO_API_KEY_SECRET')?.trim() ?? '';
    const service = this.config.get<string>('TWILIO_MESSAGING_SERVICE_SID')?.trim() ?? '';
    if (!/^AC[\da-f]{32}$/i.test(account) || !/^SK[\da-f]{32}$/i.test(key) ||
        !secret || !/^MG[\da-f]{32}$/i.test(service)) {
      throw new ServiceUnavailableException('Estimate SMS is unavailable. Check the SMS configuration.');
    }
    try {
      const url = new URL(this.config.get<string>('PUBLIC_FRONTEND_URL') || this.config.get<string>('FRONTEND_URL') || '');
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid public origin.');
      return { account, key, secret, service, origin: url.origin };
    } catch {
      throw new ServiceUnavailableException('Estimate SMS is unavailable. Configure the secure public website URL.');
    }
  }

  async assertReady(value: string): Promise<string> {
    const phone = normalizeEstimateSmsPhone(value);
    if (!phone) throw new BadRequestException('Enter a valid phone number supported for SMS, including its +1 country code.');
    this.settings();
    if (await this.prisma.smsPhoneBlock.findUnique({ where: { phone } })) {
      throw new ConflictException('This number has stopped SMS messages. The recipient must reply START before another SMS can be sent.');
    }
    return phone;
  }

  async send(input: EstimateShareSms): Promise<EstimateShareSmsResult> {
    const phone = await this.assertReady(input.phone);
    const settings = this.settings();
    const pathMatch = /^\/public\/estimates\/[a-zA-Z0-9_-]+(?:\/agreements\/[a-zA-Z0-9_-]+)?$/.exec(input.path);
    if (!pathMatch || pathMatch[0] !== input.path) {
      throw new BadRequestException('Could not create a valid customer estimate link.');
    }
    const number = excerpt(String(input.estimateNumber), 50);
    if (!number) throw new BadRequestException('The estimate number is missing.');
    const branding = await this.prisma.branding.findFirst({
      where: { type: BrandingType.COMPANY, isActive: true }, select: { name: true },
    });
    const company = excerpt(branding?.name || 'Authentic Evolution Co', 60) || 'Authentic Evolution Co';
    const firstName = excerpt(cleanText(input.customerName ?? '').split(' ')[0] ?? '', 32);
    const link = new URL(input.path, settings.origin).href;
    // Keep the complete link intact. A long token/contract route may require
    // multiple SMS segments; shortening the URL would break the customer view.
    const message = `${company}: ${firstName ? `Hi ${firstName}, your` : 'Your'} estimate #${number} is ready. View it here: ${link}\nReply STOP to unsubscribe.`;
    const { origin: _origin, ...transportSettings } = settings;
    let result;
    try {
      result = await deliverSms(transportSettings, phone, message);
    } catch {
      return { status: 'unknown', message: 'SMS acceptance was not confirmed. Check whether it arrived before sending again.' };
    }
    if (result.status === 'ACCEPTED') return { status: 'sent' };
    if (result.errorCode === '21610') {
      await this.prisma.smsPhoneBlock.upsert({
        where: { phone }, create: { phone }, update: { createdAt: new Date() },
      });
      return { status: 'failed', message: 'This number has stopped SMS messages. The recipient must reply START before another SMS can be sent.' };
    }
    if (result.status === 'UNKNOWN') {
      return { status: 'unknown', message: 'SMS acceptance was not confirmed. Check whether it arrived before sending again.' };
    }
    return { status: 'failed', message: result.status === 'RETRY'
      ? 'The SMS service is busy. The message was not accepted; try again later.'
      : 'The SMS service did not accept this message. Check the phone number before trying again.' };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  Notification,
  NotificationSms,
  NotificationSmsStatus,
  Prisma,
} from '@prisma/client';
import axios, { AxiosResponse } from 'axios';
import { PrismaService } from '@/prisma/prisma.service';
import { SmsConsentService } from '@/sms/sms-consent.service';

const recipientSelect = {
  phone: true,
  isActive: true,
  deletedAt: true,
  dealerMode: true,
  role: { select: { name: true } },
  smsConsent: true,
} satisfies Prisma.UserSelect;
type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;
type SmsSettings = {
  account: string;
  key: string;
  secret: string;
  service: string;
};
type TwilioResponse = {
  sid?: string;
  status?: string;
  code?: number;
  error_code?: number;
};

const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

@Injectable()
export class NotificationSmsService {
  private readonly logger = new Logger(NotificationSmsService.name);
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly consent: SmsConsentService,
  ) {}

  private settings(): SmsSettings | null {
    const account = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() ?? '';
    const key = this.config.get<string>('TWILIO_API_KEY_SID')?.trim() ?? '';
    const secret =
      this.config.get<string>('TWILIO_API_KEY_SECRET')?.trim() ?? '';
    const service =
      this.config.get<string>('TWILIO_MESSAGING_SERVICE_SID')?.trim() ?? '';
    if (
      !/^AC[\da-f]{32}$/i.test(account) ||
      !/^SK[\da-f]{32}$/i.test(key) ||
      !secret ||
      !/^MG[\da-f]{32}$/i.test(service)
    )
      return null;
    return { account, key, secret, service };
  }

  private isEligible(user: Recipient | null): user is Recipient {
    if (!user?.isActive || user.deletedAt) return false;
    const role = user.role.name.toLowerCase();
    // El proyecto trata a los dealers anteriores sin modo como EXTERNAL.
    if (
      role !== 'client' &&
      !(role === 'dealer' && (user.dealerMode ?? 'EXTERNAL') === 'EXTERNAL')
    )
      return false;
    const consent = user.smsConsent;
    return Boolean(
      /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(user.phone) &&
        consent?.enabled &&
        consent.phone === user.phone &&
        consent.consentedAt &&
        consent.consentVersion &&
        consent.consentText &&
        !consent.revokedAt,
    );
  }

  async enqueue(notification: Notification, db: Prisma.TransactionClient) {
    // Sin credenciales, el desarrollo local y las notificaciones de la app siguen funcionando.
    if (!this.settings()) return;
    const user = await db.user.findUnique({
      where: { id: notification.recipientId },
      select: recipientSelect,
    });
    if (!this.isEligible(user)) return;
    if (await db.smsPhoneBlock.findUnique({ where: { phone: user.phone } }))
      return;
    await db.notificationSms.create({
      data: {
        notificationId: notification.id,
        phone: user.phone,
        consentedAt: user.smsConsent!.consentedAt!,
      },
    });
  }

  private messageBody(
    notification: Notification,
    companyName: string,
  ): string {
    const clean = (value: string) =>
      value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const name = Array.from(clean(companyName)).slice(0, 80).join('');
    const message = clean(notification.message);
    // El SMS informa del evento sin enlaces; conserva la compañía y la instrucción STOP.
    const shortMessage =
      Array.from(message).length > 320
        ? `${Array.from(message).slice(0, 317).join('')}...`
        : message;
    return `${name}: ${shortMessage}\nReply STOP to unsubscribe.`;
  }

  @Interval(10_000)
  async processPending(): Promise<void> {
    if (this.processing) return;
    const settings = this.settings();
    if (!settings) return;
    this.processing = true;
    try {
      const now = new Date();
      // Tras una caída no sabemos si Twilio recibió el POST. No se repite a ciegas.
      const stale = await this.prisma.notificationSms.updateMany({
        where: {
          status: 'SENDING',
          attemptedAt: { lt: new Date(now.getTime() - STALE_ATTEMPT_MS) },
        },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' },
      });
      if (stale.count)
        this.logger.warn(
          `${stale.count} SMS attempts require review in Twilio logs.`,
        );
      await this.prisma.notificationSms.updateMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(now.getTime() - MAX_AGE_MS) },
        },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' },
      });
      const pending = await this.prisma.notificationSms.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { notificationId: 'asc' }],
        take: 20,
      });
      if (!pending.length) return;
      const { companyName } = await this.consent.getProgram();
      for (const entry of pending) {
        try {
          await this.send(entry, settings, companyName);
        } catch {
          // Nunca registrar objetos Axios, teléfonos, cuerpos ni credenciales.
          this.logger.error(
            `Could not finish SMS notification #${entry.notificationId}.`,
          );
        }
      }
    } catch {
      this.logger.error('Could not process the SMS notification queue.');
    } finally {
      this.processing = false;
    }
  }

  private async finish(
    id: number,
    status: NotificationSmsStatus,
    errorCode: string | null = null,
    sid?: string,
  ) {
    await this.prisma.notificationSms.updateMany({
      where: { notificationId: id, status: 'SENDING' },
      data: { status, errorCode, ...(sid ? { providerMessageSid: sid } : {}) },
    });
    if (status === 'FAILED' || status === 'UNKNOWN') {
      this.logger.warn(
        `SMS notification #${id}: ${status} (${errorCode ?? 'UNKNOWN'}).`,
      );
    }
  }

  private async send(
    entry: NotificationSms,
    settings: SmsSettings,
    companyName: string,
  ) {
    const id = entry.notificationId;
    // Compare-and-set en MySQL: solo un proceso de PM2 puede reclamar este envío.
    const claimed = await this.prisma.notificationSms.updateMany({
      where: {
        notificationId: id,
        status: 'PENDING',
        attempts: entry.attempts,
        nextAttemptAt: { lte: new Date() },
      },
      data: {
        status: 'SENDING',
        attemptedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return;

    const notification = await this.prisma.notification.findUnique({
      where: { id },
      include: { recipient: { select: recipientSelect } },
    });
    const user = notification?.recipient ?? null;
    if (
      !notification ||
      !this.isEligible(user) ||
      user.phone !== entry.phone ||
      user.smsConsent!.consentedAt!.getTime() !== entry.consentedAt.getTime()
    ) {
      await this.finish(id, 'SKIPPED', 'RECIPIENT_OR_CONSENT_CHANGED');
      return;
    }
    if (
      await this.prisma.smsPhoneBlock.findUnique({
        where: { phone: entry.phone },
      })
    ) {
      await this.finish(id, 'SKIPPED', 'PROVIDER_STOP');
      return;
    }

    const body = new URLSearchParams({
      To: entry.phone,
      MessagingServiceSid: settings.service,
      Body: this.messageBody(notification, companyName),
    });
    let response: AxiosResponse<TwilioResponse>;
    try {
      response = await axios.post<TwilioResponse>(
        `https://api.twilio.com/2010-04-01/Accounts/${settings.account}/Messages.json`,
        body.toString(),
        {
          auth: { username: settings.key, password: settings.secret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
          maxRedirects: 0,
          validateStatus: () => true,
        },
      );
    } catch {
      await this.finish(id, 'UNKNOWN', 'NETWORK_ERROR');
      return;
    }
    const sid =
      typeof response.data?.sid === 'string' &&
      /^(?:SM|MM)[\da-f]{32}$/i.test(response.data.sid)
        ? response.data.sid
        : undefined;
    const code = response.data?.code ?? response.data?.error_code;
    const errorCode = Number.isInteger(code)
      ? String(code)
      : `HTTP_${response.status}`;
    if (response.status >= 200 && response.status < 300) {
      if (!sid) {
        await this.finish(id, 'UNKNOWN', 'INVALID_PROVIDER_RESPONSE');
      } else if (
        ['failed', 'undelivered', 'canceled'].includes(
          response.data.status ?? '',
        )
      ) {
        await this.finish(id, 'FAILED', errorCode, sid);
      } else {
        // ACCEPTED significa recibido por Twilio, no entregado al teléfono.
        await this.finish(id, 'ACCEPTED', null, sid);
      }
      return;
    }
    if (response.status === 429 && !sid && entry.attempts + 1 < MAX_ATTEMPTS) {
      // Twilio confirma que los HTTP 429 no se procesan: este reintento sí es seguro.
      await this.prisma.notificationSms.updateMany({
        where: { notificationId: id, status: 'SENDING' },
        data: {
          status: 'PENDING',
          errorCode,
          nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** entry.attempts),
        },
      });
      return;
    }
    if (code === 21610) {
      // Sincroniza una baja aunque su webhook no haya llegado. No inventa un MessageSid.
      await this.consent.recordProviderChoice(entry.phone, null, 'STOP');
    }
    await this.finish(
      id,
      response.status >= 500 || sid ? 'UNKNOWN' : 'FAILED',
      errorCode,
      sid,
    );
  }
}

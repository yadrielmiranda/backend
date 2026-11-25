import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  Notification,
  NotificationSms,
  NotificationSmsStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SmsConsentService } from '@/sms/sms-consent.service';
import { supportsSmsPhone } from '@/sms/sms-phone-support';
import { isSmsDeliveryEnabled } from '@/sms/sms-delivery-policy';
import { hasActiveServiceSmsConsent } from '@/sms/sms-recipient-policy';
import { deliverSms, SmsDeliveryResult, SmsSettings } from '@/sms/sms-transport';
import { renderWelcomeSms } from '@/sms/welcome-sms-template';
import { renderRegistrationResultSms } from '@/dealer-network/dealer-registration-result-template';
import {
  allowsStaffNotificationDelivery,
  isStaffNotification,
  isOwnerProjectNotification,
  isSuppressedInstallationNotification,
  registrationReviewerRole,
} from './notification-delivery-policy';

const recipientSelect = {
  phone: true,
  isActive: true,
  deletedAt: true,
  dealerMode: true,
  role: { select: { name: true } },
  smsConsent: true,
} satisfies Prisma.UserSelect;
type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;
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
    if (!isSmsDeliveryEnabled(this.config)) return null;
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

  private isEligible(user: Recipient | null, notification: Pick<Notification, 'dedupeKey'>): user is Recipient {
    if (!hasActiveServiceSmsConsent(user)) return false;
    const role = user.role.name.toLowerCase();
    const reviewerRole = registrationReviewerRole(notification);
    if (reviewerRole) return role === reviewerRole;
    // Una compra de Materials avisa a su comprador registrado, también si es
    // dealer interno o personal. No habilita el aviso general de administración.
    if (/^material-sale:\d+:paid:customer$/.test(notification.dedupeKey ?? ''))
      return ['admin', 'operator', 'client', 'dealer'].includes(role);
    // Los avisos del personal nunca pasan al público al cambiar el rol del destinatario.
    // Los dealers internos reciben los avisos operativos de sus proyectos.
    if (isStaffNotification(notification)
      ? !allowsStaffNotificationDelivery(notification, role)
      : role !== 'client' &&
        !(role === 'dealer' && ((user.dealerMode ?? 'EXTERNAL') === 'EXTERNAL'
          || (user.dealerMode === 'INTERNAL' && isOwnerProjectNotification(notification)))))
      return false;
    return true;
  }

  canSendAccountWelcomeSms(): boolean {
    return this.settings() !== null;
  }

  /** The welcome outbox has already rechecked the account's current service consent. */
  async sendAccountWelcomeSms(input: { phone: string; firstName: string | null; isDealerApproval?: boolean }): Promise<SmsDeliveryResult> {
    const message = input.isDealerApproval
      ? renderRegistrationResultSms(true, this.config.get<string>('PUBLIC_FRONTEND_URL'))
      : renderWelcomeSms(input.firstName);
    return this.sendAccountSms(input.phone, message);
  }

  async sendDealerRegistrationRejectionSms(phone: string): Promise<SmsDeliveryResult> {
    return this.sendAccountSms(phone, renderRegistrationResultSms(false));
  }

  private async sendAccountSms(phone: string, message: string): Promise<SmsDeliveryResult> {
    const settings = this.settings();
    if (!settings) return { status: 'UNAVAILABLE', errorCode: 'SMS_UNAVAILABLE' };
    if (!supportsSmsPhone(phone)) return { status: 'FAILED', errorCode: 'UNSUPPORTED_PHONE' };
    return this.deliver(settings, phone, message);
  }

  private async deliver(settings: SmsSettings, phone: string, body: string): Promise<SmsDeliveryResult> {
    const result = await deliverSms(settings, phone, body);
    if (result.status !== 'ACCEPTED' && result.errorCode === '21610') {
      // Provider STOP applies to both notification and welcome outboxes.
      await this.consent.recordProviderChoice(phone, null, 'STOP');
    }
    return result;
  }

  async enqueue(notification: Notification, db: Prisma.TransactionClient) {
    if (isSuppressedInstallationNotification(notification)) return;
    // Solo el comprador recibe SMS de Materials; el aviso administrativo no.
    if (/^material-sale:\d+:paid$/.test(notification.dedupeKey ?? '')) return;
    // El bloqueo de desarrollo se aplica aun si hay credenciales de producción copiadas.
    if (!this.settings()) return;
    const user = await db.user.findUnique({
      where: { id: notification.recipientId },
      select: recipientSelect,
    });
    if (!this.isEligible(user, notification)) return;
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
    const shortMessage =
      Array.from(message).length > 320
        ? `${Array.from(message).slice(0, 317).join('')}...`
        : message;
    const lines = [`${name}: ${shortMessage}`];
    if (registrationReviewerRole(notification)) {
      const configured = this.config.get<string>('PUBLIC_FRONTEND_URL');
      const origin = configured && URL.canParse(configured) ? new URL(configured) : null;
      const path = notification.actionUrl ?? '';
      const linked = origin?.protocol === 'https:' && !origin.username && !origin.password &&
        /^\/dealers\?registrationRequest=\d+$/.test(path);
      lines.push(linked ? `Review application: ${new URL(path, origin).href}` : 'Review the application in your dealer network.');
    }
    lines.push('Reply STOP to unsubscribe.');
    return lines.join('\n');
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
      isSuppressedInstallationNotification(notification) ||
      /^material-sale:\d+:paid$/.test(notification.dedupeKey ?? '') ||
      !this.isEligible(user, notification) ||
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

    const result = await this.deliver(settings, entry.phone, this.messageBody(notification, companyName));
    if (result.status === 'ACCEPTED') {
      // ACCEPTED means Twilio accepted the request, not handset delivery.
      await this.finish(id, 'ACCEPTED', null, result.providerMessageSid);
      return;
    }
    if (result.status === 'RETRY' && entry.attempts + 1 < MAX_ATTEMPTS) {
      // Twilio confirma que los HTTP 429 no se procesan: este reintento sí es seguro.
      await this.prisma.notificationSms.updateMany({
        where: { notificationId: id, status: 'SENDING' },
        data: {
          status: 'PENDING',
          errorCode: result.errorCode,
          nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** entry.attempts),
        },
      });
      return;
    }
    await this.finish(
      id,
      result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
      result.errorCode,
      result.providerMessageSid,
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { DealerRegistrationDeliveryChannel, DealerRegistrationRejectionDelivery, DealerRegistrationRequest, Prisma } from '@prisma/client';
import { NotificationEmailService } from '@/notifications/notification-email.service';
import { NotificationSmsService } from '@/notifications/notification-sms.service';
import { PrismaService } from '@/prisma/prisma.service';
import { supportsSmsPhone } from '@/sms/sms-phone-support';
import { dealerRegistrationSmsStopped } from './dealer-registration-consent';

type Applicant = Pick<DealerRegistrationRequest,
  'id' | 'email' | 'phone' | 'preferredLanguage' | 'serviceSmsAccepted' |
  'smsConsentedAt' | 'smsConsentVersion' | 'smsConsentText'>;

const MAX_ATTEMPTS = 3;
const MAX_AGE = 24 * 60 * 60_000;
const STALE_ATTEMPT = 10 * 60_000;

@Injectable()
export class DealerRegistrationRejectionService {
  private readonly logger = new Logger(DealerRegistrationRejectionService.name);
  private processing = false;

  constructor(private readonly db: PrismaService, private readonly email: NotificationEmailService,
    private readonly sms: NotificationSmsService) {}

  /** Snapshot only the address and consent needed after the reviewed request is removed. */
  async enqueue(applicant: Applicant, tx: Prisma.TransactionClient) {
    const rows: Prisma.DealerRegistrationRejectionDeliveryCreateManyInput[] = [];
    const base = { requestId: applicant.id, language: applicant.preferredLanguage };
    if (this.email.canSendAccountWelcomeEmail()) rows.push({ ...base, channel: 'EMAIL', destination: applicant.email });
    if (this.sms.canSendAccountWelcomeSms() && applicant.serviceSmsAccepted && supportsSmsPhone(applicant.phone) &&
      applicant.smsConsentedAt && applicant.smsConsentVersion && applicant.smsConsentText &&
      !await dealerRegistrationSmsStopped(tx, applicant.phone, applicant.smsConsentedAt)) {
      rows.push({ ...base, channel: 'SMS', destination: applicant.phone, smsConsentedAt: applicant.smsConsentedAt,
        smsConsentVersion: applicant.smsConsentVersion, smsConsentText: applicant.smsConsentText });
    }
    if (rows.length) await tx.dealerRegistrationRejectionDelivery.createMany({ data: rows, skipDuplicates: true });
  }

  @Interval(10_000)
  async processPending() {
    if (this.processing) return;
    const channels: DealerRegistrationDeliveryChannel[] = [];
    if (this.email.canSendAccountWelcomeEmail()) channels.push('EMAIL');
    if (this.sms.canSendAccountWelcomeSms()) channels.push('SMS');
    if (!channels.length) return;
    this.processing = true;
    try {
      const now = new Date();
      const channel = { in: channels };
      const queue = this.db.dealerRegistrationRejectionDelivery;
      // An interrupted delivery may have been accepted already. Do not retry an ambiguous result.
      await queue.updateMany({ where: { channel, status: 'SENDING', attemptedAt: { lt: new Date(+now - STALE_ATTEMPT) } },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' } });
      await queue.updateMany({ where: { channel, status: 'PENDING', createdAt: { lt: new Date(+now - MAX_AGE) } },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' } });
      const rows = await queue.findMany({ where: { channel, status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { requestId: 'asc' }], take: 20 });
      for (const row of rows) {
        try { await this.deliver(row); }
        catch { this.logger.error(`Could not finish ${row.channel} for dealer registration #${row.requestId}.`); }
      }
    } catch {
      this.logger.error('Could not process dealer registration rejection notifications.');
    } finally { this.processing = false; }
  }

  private async deliver(row: DealerRegistrationRejectionDelivery) {
    const queue = this.db.dealerRegistrationRejectionDelivery;
    const identity = { requestId: row.requestId, channel: row.channel };
    const claim = await queue.updateMany({
      where: { ...identity, status: 'PENDING', attempts: row.attempts, nextAttemptAt: { lte: new Date() } },
      data: { status: 'SENDING', attemptedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return;
    const attempts = row.attempts + 1;
    const where = { ...identity, status: 'SENDING', attempts } as const;
    if (row.channel === 'SMS' && (!row.smsConsentText || !row.smsConsentVersion || !row.smsConsentedAt ||
      !supportsSmsPhone(row.destination) || await dealerRegistrationSmsStopped(this.db, row.destination, row.smsConsentedAt))) {
      await queue.updateMany({ where, data: { status: 'SKIPPED', errorCode: 'SMS_PERMISSION_UNAVAILABLE' } });
      return;
    }
    const result = row.channel === 'SMS'
      ? await this.sms.sendDealerRegistrationRejectionSms(row.destination, row.language)
      : await this.email.sendDealerRegistrationRejection(row.destination, row.language);
    const providerMessageId = 'providerMessageSid' in result ? result.providerMessageSid
      : 'providerMessageId' in result ? result.providerMessageId : undefined;
    if (result.status === 'ACCEPTED') {
      await queue.updateMany({ where, data: { status: 'ACCEPTED', errorCode: null, providerMessageId: providerMessageId?.slice(0, 320) } });
    } else if (result.status === 'UNAVAILABLE' || (result.status === 'RETRY' && attempts < MAX_ATTEMPTS)) {
      // UNAVAILABLE is detected before any provider call and does not consume an attempt.
      await queue.updateMany({ where, data: { status: 'PENDING', errorCode: result.errorCode,
        nextAttemptAt: new Date(Date.now() + 60_000 * attempts),
        ...(result.status === 'UNAVAILABLE' ? { attempts: { decrement: 1 }, attemptedAt: null } : {}) } });
    } else {
      await queue.updateMany({ where, data: { status: result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        errorCode: result.errorCode, providerMessageId: providerMessageId?.slice(0, 320) } });
    }
  }
}

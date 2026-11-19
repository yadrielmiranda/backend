import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AccountWelcomeSms, DealerPreferredLanguage, NotificationSmsStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationSmsService } from '@/notifications/notification-sms.service';
import { hasActiveServiceSmsConsent } from './sms-recipient-policy';

const recipientSelect = {
  firstName: true, phone: true, isActive: true, deletedAt: true, smsConsent: true,
} satisfies Prisma.UserSelect;

const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

@Injectable()
export class WelcomeSmsService {
  private readonly logger = new Logger(WelcomeSmsService.name);
  private processing = false;

  constructor(private readonly prisma: PrismaService, private readonly sms: NotificationSmsService) {}

  /** Only called from new-account creation; no provider calls inside the transaction. */
  async enqueue(userId: number, db: Prisma.TransactionClient, approvalLanguage?: DealerPreferredLanguage): Promise<void> {
    if (!this.sms.canSendAccountWelcomeSms()) return;
    const user = await db.user.findUnique({ where: { id: userId }, select: recipientSelect });
    if (!hasActiveServiceSmsConsent(user)) return;
    if (await db.smsPhoneBlock.findUnique({ where: { phone: user.phone } })) return;
    await db.accountWelcomeSms.createMany({
      data: [{ userId, phone: user.phone, consentedAt: user.smsConsent.consentedAt, approvalLanguage }],
      skipDuplicates: true,
    });
  }

  @Interval(10_000)
  async processPending(): Promise<void> {
    // Disabled development workers must leave restored outboxes entirely untouched.
    if (this.processing || !this.sms.canSendAccountWelcomeSms()) return;
    this.processing = true;
    try {
      const now = new Date();
      // A provider may have accepted an interrupted attempt. Do not send it twice.
      await this.prisma.accountWelcomeSms.updateMany({
        where: { status: 'SENDING', attemptedAt: { lt: new Date(now.getTime() - STALE_ATTEMPT_MS) } },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' },
      });
      await this.prisma.accountWelcomeSms.updateMany({
        where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - MAX_AGE_MS) } },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' },
      });
      const rows = await this.prisma.accountWelcomeSms.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { userId: 'asc' }], take: 20,
      });
      for (const row of rows) {
        try { await this.send(row); }
        catch { this.logger.error(`Could not finish welcome SMS for account #${row.userId}.`); }
      }
    } catch {
      this.logger.error('Could not process the welcome SMS queue.');
    } finally { this.processing = false; }
  }

  private async finish(userId: number, status: NotificationSmsStatus, errorCode: string | null = null, sid?: string) {
    await this.prisma.accountWelcomeSms.updateMany({
      where: { userId, status: 'SENDING' },
      data: { status, errorCode, ...(sid ? { providerMessageSid: sid } : {}) },
    });
    if (status === 'FAILED' || status === 'UNKNOWN')
      this.logger.warn(`Welcome SMS for account #${userId}: ${status} (${errorCode ?? 'UNKNOWN'}).`);
  }

  private async send(row: AccountWelcomeSms): Promise<void> {
    const claimed = await this.prisma.accountWelcomeSms.updateMany({
      where: { userId: row.userId, status: 'PENDING', attempts: row.attempts, nextAttemptAt: { lte: new Date() } },
      data: { status: 'SENDING', attemptedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: recipientSelect });
    if (!hasActiveServiceSmsConsent(user) || user.phone !== row.phone ||
      user.smsConsent.consentedAt.getTime() !== row.consentedAt.getTime()) {
      await this.finish(row.userId, 'SKIPPED', 'RECIPIENT_OR_CONSENT_CHANGED');
      return;
    }
    if (await this.prisma.smsPhoneBlock.findUnique({ where: { phone: row.phone } })) {
      await this.finish(row.userId, 'SKIPPED', 'PROVIDER_STOP');
      return;
    }
    const result = await this.sms.sendAccountWelcomeSms({
      phone: row.phone, firstName: user.firstName, approvalLanguage: row.approvalLanguage ?? undefined,
    });
    if (result.status === 'ACCEPTED') {
      await this.finish(row.userId, 'ACCEPTED', null, result.providerMessageSid);
    } else if (result.status === 'UNAVAILABLE') {
      // No provider attempt occurred if delivery was disabled after the claim.
      await this.prisma.accountWelcomeSms.updateMany({
        where: { userId: row.userId, status: 'SENDING' },
        data: { status: 'PENDING', attempts: { decrement: 1 }, attemptedAt: null,
          errorCode: result.errorCode, nextAttemptAt: new Date(Date.now() + 60_000) },
      });
    } else if (result.status === 'RETRY' && row.attempts + 1 < MAX_ATTEMPTS) {
      await this.prisma.accountWelcomeSms.updateMany({
        where: { userId: row.userId, status: 'SENDING' },
        data: { status: 'PENDING', errorCode: result.errorCode,
          nextAttemptAt: new Date(Date.now() + 60_000 * (row.attempts + 1)) },
      });
    } else {
      await this.finish(row.userId, result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', result.errorCode, result.providerMessageSid);
    }
  }
}

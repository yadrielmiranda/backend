import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AccountWelcomeEmail, NotificationEmailStatus, Prisma } from '@prisma/client';
import { isEmail } from 'class-validator';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationEmailService } from '@/notifications/notification-email.service';

const recipientSelect = {
  firstName: true, username: true, email: true, contactEmail: true,
  isActive: true, deletedAt: true, role: { select: { name: true } },
} satisfies Prisma.UserSelect;
type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;

@Injectable()
export class WelcomeEmailService {
  private readonly logger = new Logger(WelcomeEmailService.name);
  private processing = false;

  constructor(private readonly prisma: PrismaService, private readonly email: NotificationEmailService) {}

  private recipientEmail(user: Recipient | null): string | null {
    if (!user?.isActive || user.deletedAt) return null;
    const value = user.role.name.toLowerCase() === 'technician' ? user.contactEmail : user.email;
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && isEmail(email) ? email : null;
  }

  /** Called only during new-account creation, inside the same transaction. No network I/O. */
  async enqueue(userId: number, db: Prisma.TransactionClient): Promise<void> {
    const user = await db.user.findUnique({ where: { id: userId }, select: recipientSelect });
    const email = this.recipientEmail(user);
    if (!email) return;
    // A single durable delivery per account, even when different accounts share a contact address.
    await db.accountWelcomeEmail.createMany({ data: [{ userId, email }], skipDuplicates: true });
  }

  @Interval(10_000)
  async processPending(): Promise<void> {
    if (this.processing || !this.email.canSendAccountWelcomeEmail()) return;
    this.processing = true;
    try {
      const now = new Date();
      // SMTP may already have accepted a message when a worker dies: never resend blindly.
      await this.prisma.accountWelcomeEmail.updateMany({
        where: { status: 'SENDING', attemptedAt: { lt: new Date(now.getTime() - STALE_ATTEMPT_MS) } },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' },
      });
      await this.prisma.accountWelcomeEmail.updateMany({
        where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - MAX_AGE_MS) } },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' },
      });
      const rows = await this.prisma.accountWelcomeEmail.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { userId: 'asc' }], take: 20,
      });
      for (const row of rows) {
        try { await this.send(row); }
        catch { this.logger.error(`Could not finish welcome email for account #${row.userId}.`); }
      }
    } catch {
      this.logger.error('Could not process the welcome email queue.');
    } finally { this.processing = false; }
  }

  private async finish(userId: number, status: NotificationEmailStatus, errorCode: string | null = null, messageId?: string) {
    await this.prisma.accountWelcomeEmail.updateMany({
      where: { userId, status: 'SENDING' },
      data: { status, errorCode, ...(messageId ? { providerMessageId: messageId.slice(0, 320) } : {}) },
    });
    if (status === 'FAILED' || status === 'UNKNOWN')
      this.logger.warn(`Welcome email for account #${userId}: ${status} (${errorCode ?? 'UNKNOWN'}).`);
  }

  private async send(row: AccountWelcomeEmail): Promise<void> {
    const claimed = await this.prisma.accountWelcomeEmail.updateMany({
      where: { userId: row.userId, status: 'PENDING', attempts: row.attempts, nextAttemptAt: { lte: new Date() } },
      data: { status: 'SENDING', attemptedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: recipientSelect });
    if (!user || this.recipientEmail(user) !== row.email) {
      await this.finish(row.userId, 'SKIPPED', 'RECIPIENT_CHANGED');
      return;
    }
    const result = await this.email.sendAccountWelcome({
      to: row.email, firstName: user.firstName, username: user.username, roleName: user.role.name,
    });
    if (result.status === 'ACCEPTED') {
      await this.finish(row.userId, 'ACCEPTED', null, result.providerMessageId);
    } else if (result.status === 'UNAVAILABLE') {
      // Configuration became unavailable after the claim; no SMTP attempt was made.
      await this.prisma.accountWelcomeEmail.updateMany({
        where: { userId: row.userId, status: 'SENDING' },
        data: { status: 'PENDING', attempts: { decrement: 1 }, attemptedAt: null,
          errorCode: result.errorCode, nextAttemptAt: new Date(Date.now() + 60_000) },
      });
    } else if (result.status === 'RETRY' && row.attempts + 1 < MAX_ATTEMPTS) {
      await this.prisma.accountWelcomeEmail.updateMany({
        where: { userId: row.userId, status: 'SENDING' },
        data: { status: 'PENDING', errorCode: result.errorCode,
          nextAttemptAt: new Date(Date.now() + 60_000 * (row.attempts + 1)) },
      });
    } else {
      await this.finish(row.userId, result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', result.errorCode);
    }
  }
}

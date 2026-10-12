import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MaterialSale, MaterialSaleEmail, NotificationEmailStatus, Prisma } from '@prisma/client';
import { isEmail } from 'class-validator';
import { NotificationEmailService } from '@/notifications/notification-email.service';
import { PrismaService } from '@/prisma/prisma.service';

type Purchase = Pick<MaterialSale, 'id' | 'customerEmail' | 'customerName' | 'code' | 'total' | 'currency' | 'publicToken'>;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;
const normalizeEmail = (value: string | null) => value?.trim().toLowerCase() ?? '';

/** Guest receipts have no account or bell notification, but still need a durable outbox. */
@Injectable()
export class MaterialSaleEmailService {
  private readonly logger = new Logger(MaterialSaleEmailService.name);
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: NotificationEmailService,
  ) {}

  async enqueue(sale: Purchase, db: Prisma.TransactionClient): Promise<void> {
    const email = normalizeEmail(sale.customerEmail);
    if (!email || email.length > 254 || !isEmail(email)) return;
    // Persist with the fully-paid event, even if SMTP has not been configured yet.
    // The unique saleId also prevents a webhook retry from creating another receipt.
    await db.materialSaleEmail.createMany({
      data: [{
        saleId: sale.id,
        email,
        customerName: sale.customerName,
        saleCode: sale.code,
        total: sale.total,
        currency: sale.currency,
        publicToken: sale.publicToken,
      }],
      skipDuplicates: true,
    });
  }

  @Interval(10_000)
  async processPending(): Promise<void> {
    if (this.processing || !this.emails.canSendMaterialPurchaseEmail()) return;
    this.processing = true;
    try {
      const now = new Date();
      // A crash can occur after acceptance but before saving the result. Do not resend.
      await this.prisma.materialSaleEmail.updateMany({
        where: { status: 'SENDING', attemptedAt: { lt: new Date(now.getTime() - STALE_ATTEMPT_MS) } },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' },
      });
      await this.prisma.materialSaleEmail.updateMany({
        where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - MAX_AGE_MS) } },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' },
      });
      const pending = await this.prisma.materialSaleEmail.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 20,
      });
      for (const entry of pending) {
        try {
          await this.send(entry);
        } catch {
          // No private SMTP responses, invoice tokens or recipient addresses in logs.
          this.logger.error(`Could not finish material purchase email #${entry.id}.`);
        }
      }
    } catch {
      this.logger.error('Could not process the material purchase email queue.');
    } finally {
      this.processing = false;
    }
  }

  private async finish(id: number, status: NotificationEmailStatus, errorCode: string | null = null, providerMessageId?: string) {
    await this.prisma.materialSaleEmail.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status,
        errorCode,
        ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : {}),
        ...(providerMessageId ? { providerMessageId: providerMessageId.slice(0, 320) } : {}),
      },
    });
    if (status === 'FAILED' || status === 'UNKNOWN')
      this.logger.warn(`Material purchase email #${id}: ${status} (${errorCode ?? 'UNKNOWN'}).`);
  }

  private async send(entry: MaterialSaleEmail): Promise<void> {
    const claimed = await this.prisma.materialSaleEmail.updateMany({
      where: { id: entry.id, status: 'PENDING', attempts: entry.attempts, nextAttemptAt: { lte: new Date() } },
      data: { status: 'SENDING', attemptedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    const sale = await this.prisma.materialSale.findUnique({
      where: { id: entry.saleId },
      select: {
        customerUserId: true, customerEmail: true, customerName: true,
        code: true, total: true, paidAmount: true, currency: true, publicToken: true, status: true,
      },
    });
    // Re-check the recipient and paid snapshot just before sending a bearer invoice link.
    if (!sale || sale.customerUserId !== null || normalizeEmail(sale.customerEmail) !== entry.email ||
      sale.customerName !== entry.customerName || sale.publicToken !== entry.publicToken ||
      sale.code !== entry.saleCode || sale.currency !== entry.currency || !sale.total.eq(entry.total)) {
      await this.finish(entry.id, 'SKIPPED', 'PURCHASE_CHANGED');
      return;
    }
    if (!['CONFIRMED', 'DELIVERED'].includes(sale.status) || !sale.total.gt(0) || sale.paidAmount.lt(sale.total)) {
      await this.finish(entry.id, 'SKIPPED', 'PURCHASE_NOT_PAID');
      return;
    }
    const result = await this.emails.sendMaterialPurchaseEmail({
      to: entry.email,
      customerName: entry.customerName,
      saleCode: entry.saleCode,
      total: entry.total.toFixed(2),
      currency: entry.currency,
      path: `/public/material-sales/${entry.publicToken}`,
    });
    if (result.status === 'UNAVAILABLE') {
      // A settings change between readiness and sending did not contact SMTP.
      await this.prisma.materialSaleEmail.updateMany({
        where: { id: entry.id, status: 'SENDING' },
        data: { status: 'PENDING', attempts: { decrement: 1 }, errorCode: result.errorCode, nextAttemptAt: new Date(Date.now() + 60_000) },
      });
    } else if (result.status === 'RETRY' && entry.attempts + 1 < MAX_ATTEMPTS) {
      await this.prisma.materialSaleEmail.updateMany({
        where: { id: entry.id, status: 'SENDING' },
        data: { status: 'PENDING', errorCode: result.errorCode, nextAttemptAt: new Date(Date.now() + 60_000 * (entry.attempts + 1)) },
      });
    } else if (result.status === 'ACCEPTED') {
      await this.finish(entry.id, 'ACCEPTED', null, result.providerMessageId);
    } else {
      await this.finish(entry.id, result.status === 'RETRY' ? 'FAILED' : result.status, result.errorCode);
    }
  }
}

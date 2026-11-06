import {
  BadRequestException, ConflictException, Injectable, InternalServerErrorException,
  Logger, NotFoundException, PayloadTooLargeException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EstimateNoteAttachmentQuota, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { NotificationsService } from '@/notifications/notifications.service';
import { PrismaService } from '@/prisma/prisma.service';
import { assertInternalNoteAccess } from './estimate-internal-note.service';
import { NOTE_ATTACHMENT_FILE_LIMIT } from './estimate-note-attachment-file';

const estimateBytes = 25_000_000;
const warningBytes = 9_000_000_000;
const maximumBytes = 10_000_000_000;
const abandonedUploadAge = 15 * 60_000;
const visibleFields = { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true } as const;

type PreparedFile = { name: string; mimeType: string; buffer: Buffer };
type Db = Prisma.TransactionClient;

@Injectable()
export class EstimateNoteAttachmentsService {
  private readonly logger = new Logger(EstimateNoteAttachmentsService.name);
  private readonly directory = resolve(process.env.NOTE_ATTACHMENTS_DIR || join(process.cwd(), 'private', 'estimate-note-attachments'));
  private cleanupAfterId?: string;
  private cleanupRunning = false;

  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {
    const publicDirectory = resolve(process.cwd(), 'uploads');
    if (this.directory === publicDirectory || this.directory.startsWith(publicDirectory + sep))
      throw new Error('NOTE_ATTACHMENTS_DIR must be outside the public uploads directory.');
  }

  assertCanUpload(estimateId: number, actor: AuthUser) {
    return assertInternalNoteAccess(this.prisma, estimateId, actor, true);
  }

  async list(estimateId: number, actor: AuthUser) {
    await assertInternalNoteAccess(this.prisma, estimateId, actor);
    const attachments = await this.prisma.estimateNoteAttachment.findMany({
      where: { estimateId, ready: true }, select: visibleFields, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let storage: { usedBytes: number; warning: boolean } | null = null;
    if (actor.role?.name === 'admin') {
      const quota = await this.prisma.estimateNoteAttachmentQuota.findUniqueOrThrow({ where: { id: 1 } });
      const usedBytes = Number(quota.usedBytes);
      storage = { usedBytes, warning: usedBytes >= warningBytes };
    }
    return { attachments, usedBytes: attachments.reduce((sum, file) => sum + file.sizeBytes, 0), storage };
  }

  private path(id: string) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new NotFoundException('Attachment not found.');
    return join(this.directory, id);
  }

  // The InnoDB lock is shared across application instances. Pending and detached files
  // keep their reservations until the bytes are physically removed.
  private withQuotaLock<T>(work: (tx: Db, quota: EstimateNoteAttachmentQuota) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM EstimateNoteAttachmentQuota WHERE id = 1 FOR UPDATE`;
      const quota = await tx.estimateNoteAttachmentQuota.findUniqueOrThrow({ where: { id: 1 } });
      return work(tx, quota);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
  }

  async add(estimateId: number, file: PreparedFile, actor: AuthUser) {
    const sizeBytes = file.buffer.length;
    if (!sizeBytes) throw new BadRequestException('Choose a photo or PDF.');
    if (sizeBytes > NOTE_ATTACHMENT_FILE_LIMIT) throw new PayloadTooLargeException('Each file must be 10 MB or smaller.');
    const id = randomUUID();

    await this.withQuotaLock(async (tx, quota) => {
      await assertInternalNoteAccess(tx, estimateId, actor, true);
      const usage = await tx.estimateNoteAttachment.aggregate({
        where: { estimateId }, _count: true, _sum: { sizeBytes: true },
      });
      if (usage._count >= 5) throw new ConflictException('An estimate can have up to 5 attachments.');
      if ((usage._sum.sizeBytes ?? 0) + sizeBytes > estimateBytes)
        throw new ConflictException('These attachments would exceed the 25 MB limit for this estimate.');
      if (Number(quota.usedBytes) + sizeBytes > maximumBytes)
        throw new ConflictException('Attachment storage is full. Contact an administrator.');
      await tx.estimateNoteAttachment.create({
        data: { id, estimateId, name: file.name, mimeType: file.mimeType, sizeBytes },
      });
      // A portal upgrading from the old 4 GB alert may already have its warning flag set.
      const rearmWarning = quota.warned && Number(quota.usedBytes) < warningBytes;
      await tx.estimateNoteAttachmentQuota.update({ where: { id: 1 }, data: {
        usedBytes: { increment: sizeBytes }, ...(rearmWarning ? { warned: false } : {}),
      } });
    });

    try {
      await this.withQuotaLock(async (tx, quota) => {
        await assertInternalNoteAccess(tx, estimateId, actor, true);
        const updated = await tx.estimateNoteAttachment.updateMany({
          where: { id, estimateId, ready: false }, data: { ready: true },
        });
        if (!updated.count) throw new ConflictException('The upload expired. Please try again.');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(this.path(id), file.buffer, { flag: 'wx', mode: 0o600, flush: true });
        if (!quota.warned && Number(quota.usedBytes) >= warningBytes) {
          await this.notifications.createAndSendToRoles(['admin'], {
            message: 'Internal estimate attachments have reached 9 GB of the 10 GB storage limit.',
            inAppOnly: true,
          }, { db: tx });
          await tx.estimateNoteAttachmentQuota.update({ where: { id: 1 }, data: { warned: true } });
        }
      });
    } catch (error) {
      // A commit acknowledgment may be lost. Only discard this upload if it is still pending.
      await this.tryCleanup(id, new Date());
      throw error;
    }
    return this.list(estimateId, actor);
  }

  async read(estimateId: number, attachmentId: string, actor: AuthUser) {
    await assertInternalNoteAccess(this.prisma, estimateId, actor);
    const where = { id: attachmentId, estimateId, ready: true };
    const file = await this.prisma.estimateNoteAttachment.findFirst({
      where, select: visibleFields,
    });
    if (!file) throw new NotFoundException('Attachment not found.');
    try {
      const buffer = await readFile(this.path(file.id));
      if (buffer.length !== file.sizeBytes) throw new Error('Incomplete attachment');
      return { buffer, name: file.name, mimeType: file.mimeType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const attached = await this.prisma.estimateNoteAttachment.findFirst({ where, select: { id: true } });
        if (!attached) throw new NotFoundException('Attachment not found.');
      }
      throw new InternalServerErrorException('The saved attachment is unavailable.');
    }
  }

  async remove(estimateId: number, attachmentId: string, actor: AuthUser) {
    await this.withQuotaLock(async (tx) => {
      await assertInternalNoteAccess(tx, estimateId, actor, true);
      const detached = await tx.estimateNoteAttachment.updateMany({
        where: { id: attachmentId, estimateId, ready: true }, data: { estimateId: null },
      });
      if (!detached.count) throw new NotFoundException('Attachment not found.');
    });
    await this.tryCleanup(attachmentId, new Date(0));
    return this.list(estimateId, actor);
  }

  private async tryCleanup(id: string, pendingBefore: Date) {
    try {
      await this.withQuotaLock(async (tx, quota) => {
        const row = await tx.estimateNoteAttachment.findFirst({
          where: { id, OR: [{ estimateId: null }, { ready: false, createdAt: { lte: pendingBefore } }] },
        });
        if (!row) return;
        await rm(this.path(row.id), { force: true });
        await tx.estimateNoteAttachment.delete({ where: { id: row.id } });
        const resetWarning = Number(quota.usedBytes) - row.sizeBytes < warningBytes;
        await tx.estimateNoteAttachmentQuota.update({ where: { id: 1 }, data: {
          usedBytes: { decrement: row.sizeBytes }, ...(resetWarning ? { warned: false } : {}),
        } });
      });
    } catch (error) {
      this.logger.warn(`Could not reclaim attachment ${id}. Cleanup will retry. ${error instanceof Error ? error.message : ''}`);
    }
  }

  // Covers a deleted estimate (FK SET NULL), process crashes and failed filesystem deletes.
  @Interval(60_000)
  async reclaimUnusedFiles() {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const cutoff = new Date(Date.now() - abandonedUploadAge);
      const stale = await this.prisma.estimateNoteAttachment.findMany({
        where: { ...(this.cleanupAfterId ? { id: { gt: this.cleanupAfterId } } : {}),
          OR: [{ estimateId: null }, { ready: false, createdAt: { lte: cutoff } }] },
        orderBy: { id: 'asc' }, take: 100, select: { id: true },
      });
      // Move past persistent failures and wrap around for another retry on the next sweep.
      this.cleanupAfterId = stale.length === 100 ? stale[stale.length - 1].id : undefined;
      for (const file of stale) await this.tryCleanup(file.id, cutoff);
    } finally {
      this.cleanupRunning = false;
    }
  }
}

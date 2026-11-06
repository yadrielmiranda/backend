import { ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { EstimateNoteAttachmentsService } from './estimate-note-attachments.service';

const admin = { id: 1, role: { name: 'admin' } } as AuthUser;
const operator = { id: 2, role: { name: 'operator' } } as AuthUser;

function fixture() {
  const quota = { id: 1, usedBytes: 9_000_000_000n, warned: true };
  const estimate = { findUnique: jest.fn().mockResolvedValue({ id: 23, idUser: 1 }) };
  const files = {
    findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(),
    delete: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: { sizeBytes: 0 } }),
  };
  const ledger = { findUniqueOrThrow: jest.fn().mockResolvedValue(quota), update: jest.fn() };
  const tx = { estimate, estimateNoteAttachment: files, estimateNoteAttachmentQuota: ledger, $queryRaw: jest.fn() };
  const transaction = jest.fn(async (work) => work(tx));
  const db = { ...tx, $transaction: transaction };
  const notifications = { createAndSendToRoles: jest.fn() };
  return {
    service: new EstimateNoteAttachmentsService(db as never, notifications as never),
    transaction, files, ledger, quota, tx, notifications,
  };
}

describe('private note attachment storage', () => {
  let directory: string;
  const originalRoot = process.env.NOTE_ATTACHMENTS_DIR;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'impact-note-attachments-'));
    process.env.NOTE_ATTACHMENTS_DIR = directory;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalRoot === undefined) delete process.env.NOTE_ATTACHMENTS_DIR;
    else process.env.NOTE_ATTACHMENTS_DIR = originalRoot;
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps operators read-only and discloses global usage only to admins', async () => {
    const { service, files } = fixture();
    await expect(service.assertCanUpload(23, operator)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(23, randomUUID(), operator)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(23, operator)).resolves.toEqual({ attachments: [], usedBytes: 0, storage: null });
    await expect(service.list(23, admin)).resolves.toHaveProperty('storage', { usedBytes: 9_000_000_000, warning: true });
    await expect(service.read(23, randomUUID(), admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(files.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: expect.any(String), estimateId: 23, ready: true,
    } }));
  });

  it('rearms an old quota alert and notifies once when usage reaches 9 GB', async () => {
    const { service, ledger, quota, notifications, tx } = fixture();
    quota.usedBytes = 5_000_000_000n;
    ledger.update.mockImplementation(async ({ data }) => {
      if (data.usedBytes) quota.usedBytes += BigInt(data.usedBytes.increment);
      if (data.warned !== undefined) quota.warned = data.warned;
    });
    const file = { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('a') };
    const below = await service.add(23, file, admin);
    expect(below.storage).toEqual({ usedBytes: 5_000_000_001, warning: false });
    expect(quota.warned).toBe(false);
    expect(notifications.createAndSendToRoles).not.toHaveBeenCalled();
    quota.usedBytes = 8_999_999_999n;
    const atWarning = await service.add(23, file, admin);
    expect(atWarning.storage).toEqual({ usedBytes: 9_000_000_000, warning: true });
    await service.add(23, file, admin);
    expect(notifications.createAndSendToRoles).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSendToRoles).toHaveBeenCalledWith(['admin'], {
      message: 'Internal estimate attachments have reached 9 GB of the 10 GB storage limit.', inAppOnly: true,
    }, { db: tx });
  });

  it('holds the reservation when disk deletion fails and releases it on retry', async () => {
    const { service, files, ledger, tx } = fixture();
    const id = randomUUID();
    await fs.writeFile(join(directory, id), 'abc');
    files.findMany.mockResolvedValue([{ id }]);
    files.findFirst.mockResolvedValue({ id, sizeBytes: 3 });
    const unlink = jest.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Disk unavailable'));
    await service.reclaimUnusedFiles();
    expect(files.delete).not.toHaveBeenCalled();
    expect(ledger.update).not.toHaveBeenCalled();
    await expect(fs.readFile(join(directory, id), 'utf8')).resolves.toBe('abc');
    unlink.mockRestore();
    await service.reclaimUnusedFiles();
    await expect(fs.access(join(directory, id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(ledger.update).toHaveBeenCalledWith({
      where: { id: 1 }, data: { usedBytes: { decrement: 3 }, warned: false },
    });
    expect(files.findFirst).toHaveBeenCalledWith({ where: { id, OR: [
      { estimateId: null }, { ready: false, createdAt: { lte: expect.any(Date) } },
    ] } });
  });

  it.each([
    ['detached during the download', false, NotFoundException],
    ['still attached but missing from storage', true, InternalServerErrorException],
  ] as const)('reports the correct failure for a file %s', async (_label, attached, failure) => {
    const { service, files } = fixture();
    const id = randomUUID();
    files.findFirst.mockResolvedValueOnce({ id, name: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 500 })
      .mockResolvedValueOnce(attached ? { id } : null);
    await expect(service.read(23, id, admin)).rejects.toBeInstanceOf(failure);
    expect(files.findFirst).toHaveBeenLastCalledWith({ where: { id, estimateId: 23, ready: true }, select: { id: true } });
  });

  it('advances cleanup past a full batch and wraps around to retry previous failures', async () => {
    const { service, files } = fixture();
    const first = Array.from({ length: 100 }, () => ({ id: randomUUID() })).sort((a, b) => a.id.localeCompare(b.id));
    files.findMany.mockResolvedValueOnce(first).mockResolvedValue([]);
    await service.reclaimUnusedFiles();
    await service.reclaimUnusedFiles();
    await service.reclaimUnusedFiles();
    expect(files.findMany.mock.calls[1][0].where.id).toEqual({ gt: first[99].id });
    expect(files.findMany.mock.calls[2][0].where.id).toBeUndefined();
  });

  it('keeps a committed file when the upload receives a lost commit acknowledgment', async () => {
    const { service, files, tx, transaction } = fixture();
    transaction.mockImplementationOnce(async (work) => work(tx));
    transaction.mockImplementationOnce(async (work) => {
      await work(tx);
      throw new Error('Lost commit acknowledgment');
    });
    files.findFirst.mockResolvedValue(null); // The committed, ready row is ineligible for cleanup.
    await expect(service.add(23, { name: 'drawing.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test') }, admin))
      .rejects.toThrow('Lost commit acknowledgment');
    const id = files.create.mock.calls[0][0].data.id;
    await expect(fs.readFile(join(directory, id), 'utf8')).resolves.toBe('test');
    expect(files.delete).not.toHaveBeenCalled();
  });

  it('reclaims an interrupted write after finalization fails and the row is still pending', async () => {
    const { service, files, ledger, tx, transaction } = fixture();
    transaction.mockImplementationOnce(async (work) => work(tx));
    transaction.mockImplementationOnce(async (work) => {
      await work(tx);
      throw new Error('Transaction rolled back');
    });
    files.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, sizeBytes: 4 }));
    await expect(service.add(23, { name: 'window.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('test') }, admin))
      .rejects.toThrow('Transaction rolled back');
    expect(await fs.readdir(directory)).toEqual([]);
    expect(files.delete).toHaveBeenCalledTimes(1);
    expect(ledger.update).toHaveBeenLastCalledWith({
      where: { id: 1 }, data: { usedBytes: { decrement: 4 }, warned: false },
    });
  });
});

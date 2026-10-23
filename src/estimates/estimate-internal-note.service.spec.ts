import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthUser, RoleName } from '@/auth/types/auth-user.type';
import { EstimateInternalNoteService } from './estimate-internal-note.service';
import { UpdateEstimateInternalNoteDto } from './dto/estimate-internal-note.dto';
import { EstimateInternalNoteController } from './estimate-internal-note.controller';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';

const actor = (id: number, role: RoleName = 'dealer'): AuthUser => ({
  id,
  role: { name: role },
});
const admin = actor(90, 'admin');
const operator = actor(91, 'operator');

function fixture() {
  const users = [
    { id: 1, parentDealerId: null, firstName: 'Root', lastName: 'Dealer', username: 'root' },
    { id: 2, parentDealerId: 1, firstName: 'Parent', lastName: 'Dealer', username: 'parent' },
    { id: 3, parentDealerId: 2, firstName: 'Owner', lastName: 'Distributor', username: 'owner' },
    { id: 4, parentDealerId: null, firstName: 'Other', lastName: 'Dealer', username: 'other' },
    { id: 5, parentDealerId: 2, firstName: 'Peer', lastName: 'Distributor', username: 'peer' },
    { id: 90, parentDealerId: null, firstName: 'Admin', lastName: 'User', username: 'admin' },
  ];
  const estimate: any = {
    id: 20,
    idUser: 3,
    status: { name: 'Active' },
    pieces: [{ id: 30, qty: 2, price: '100.00' }],
    payments: [],
    order: null,
    totalPayable: '214.00',
    paymentPlanSnapshot: { version: 1, planId: 5 },
  };
  let note: any = null;
  let tick = 0;
  const noteResult = () => note && {
    ...note,
    updatedBy: users.find((user) => user.id === note.updatedById) ?? null,
  };
  const db: any = {
    estimate: {
      findUnique: jest.fn(async ({ where }) => where.id === estimate.id ? estimate : null),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => {
        const user = users.find((row) => row.id === where.id);
        return user && {
          ...user,
          parentDealer: users.find((row) => row.id === user.parentDealerId) ?? null,
        };
      }),
    },
    estimateInternalNote: {
      findUnique: jest.fn(async ({ where }) => where.estimateId === estimate.id ? noteResult() : null),
      findUniqueOrThrow: jest.fn(async () => {
        if (!note) throw new Error('Note not found');
        return noteResult();
      }),
      create: jest.fn(async ({ data }) => {
        if (note) throw new Prisma.PrismaClientKnownRequestError('Duplicate note', {
          code: 'P2002', clientVersion: 'test', meta: { target: ['estimateId'] },
        });
        note = {
          version: 1,
          ...data,
          updatedAt: new Date(Date.UTC(2026, 9, 23, 12, 0, ++tick)),
        };
        return noteResult();
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!note || note.estimateId !== where.estimateId || note.version !== where.version) return { count: 0 };
        const nextVersion = data.version?.increment == null ? data.version : note.version + data.version.increment;
        note = {
          ...note,
          ...data,
          version: nextVersion ?? note.version,
          updatedAt: new Date(Date.UTC(2026, 9, 23, 12, 0, ++tick)),
        };
        return { count: 1 };
      }),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    piece: { update: jest.fn(), updateMany: jest.fn() },
    payment: { update: jest.fn(), updateMany: jest.fn() },
    order: { update: jest.fn() },
    estimateAgreement: { update: jest.fn() },
  };
  db.$transaction = jest.fn(async (work: (tx: any) => Promise<unknown>) => work(db));
  return {
    db, estimate, users,
    service: new EstimateInternalNoteService(db),
    seedNote(overrides: Record<string, unknown> = {}) {
      note = {
        estimateId: estimate.id,
        text: 'Confirm the delivery entrance.',
        version: 1,
        updatedAt: new Date('2026-10-22T15:00:00Z'),
        updatedById: 3,
        ...overrides,
      };
    },
    storedNote: () => note,
  };
}

describe('Estimate internal note access and editing', () => {
  it.each([
    ['administrator', admin, true],
    ['operator', operator, false],
    ['owner', actor(3), true],
    ['parent dealer', actor(2), true],
    ['grandparent dealer', actor(1), true],
  ] as const)('allows the %s to read the same shared note', async (_label, viewer, canEdit) => {
    const f = fixture();
    f.seedNote();
    const result = await f.service.getForEstimate(20, viewer);
    expect(result).toEqual({
      internalNote: {
        text: 'Confirm the delivery entrance.',
        version: 1,
        updatedAt: new Date('2026-10-22T15:00:00Z'),
        updatedBy: { id: 3, name: 'Owner Distributor' },
      },
      canEdit,
    });
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
    expect(f.db.estimateInternalNote.updateMany).not.toHaveBeenCalled();
  });

  it.each([actor(4), actor(5)])(
    'does not disclose the note to an unrelated or peer dealer %j', async (viewer) => {
      const f = fixture();
      f.seedNote();
      await expect(f.service.getForEstimate(20, viewer)).rejects.toBeInstanceOf(NotFoundException);
      expect(f.db.estimateInternalNote.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([actor(3, 'client'), actor(3, 'technician'), { id: 3 }])(
    'does not disclose a note to an unsupported role even if it owns the estimate %j', async (viewer) => {
      const f = fixture();
      f.seedNote();
      await expect(f.service.getForEstimate(20, viewer)).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.db.estimate.findUnique).not.toHaveBeenCalled();
      expect(f.db.estimateInternalNote.findUnique).not.toHaveBeenCalled();
    },
  );

  it('does not let a descendant read an ancestor estimate', async () => {
    const f = fixture();
    f.estimate.idUser = 1;
    f.seedNote();
    await expect(f.service.getForEstimate(20, actor(3))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the current authorized chain when a distributor changes parent', async () => {
    const f = fixture();
    f.seedNote();
    const owner = f.users.find((user) => user.id === 3)!;
    owner.parentDealerId = 4;
    await expect(f.service.getForEstimate(20, actor(1))).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.getForEstimate(20, actor(2))).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.getForEstimate(20, actor(4))).resolves.toMatchObject({ canEdit: true });
  });

  it('returns an empty note without creating a record', async () => {
    const f = fixture();
    await expect(f.service.getForEstimate(20, actor(3))).resolves.toEqual({ internalNote: null, canEdit: true });
    await expect(f.service.getForEstimate(20, operator)).resolves.toEqual({ internalNote: null, canEdit: false });
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
  });

  it.each([admin, actor(3), actor(2), actor(1)])('allows %j to add and edit the shared note with author/date', async (editor) => {
    const f = fixture();
    const first = await f.service.saveForEstimate(20, { text: 'First line\nSecond line', expectedVersion: 0 }, editor);
    expect(first.canEdit).toBe(true);
    expect(first.internalNote).toMatchObject({
      text: 'First line\nSecond line', version: 1, updatedBy: { id: editor.id },
    });
    expect(first.internalNote?.updatedAt).toBeInstanceOf(Date);
    const second = await f.service.saveForEstimate(20, { text: 'Changed by admin', expectedVersion: 1 }, admin);
    expect(second.internalNote).toMatchObject({
      text: 'Changed by admin', version: 2, updatedBy: { id: 90, name: 'Admin User' },
    });
    expect(second.internalNote?.updatedAt).not.toEqual(first.internalNote?.updatedAt);
    expect(f.db.$transaction).toHaveBeenCalledTimes(2);
    const reread = await f.service.getForEstimate(20, actor(2));
    expect(reread.internalNote).toEqual(second.internalNote);
  });

  it('allows clearing a note while keeping its version to prevent stale edits', async () => {
    const f = fixture();
    f.seedNote();
    const cleared = await f.service.saveForEstimate(20, { text: '', expectedVersion: 1 }, actor(3));
    expect(cleared.internalNote).toMatchObject({ text: '', version: 2 });
    expect(f.db.estimateInternalNote.delete).not.toHaveBeenCalled();
    expect(f.db.estimateInternalNote.deleteMany).not.toHaveBeenCalled();
    await expect(f.service.saveForEstimate(20, { text: 'Stale text', expectedVersion: 1 }, actor(2))).rejects.toBeInstanceOf(ConflictException);
    expect(f.storedNote().text).toBe('');
  });

  it('allows operator reading but rejects operator writing', async () => {
    const f = fixture();
    f.seedNote();
    await expect(f.service.saveForEstimate(20, { text: 'No', expectedVersion: 1 }, operator)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.storedNote().text).toBe('Confirm the delivery entrance.');
    expect(f.db.estimateInternalNote.updateMany).not.toHaveBeenCalled();
  });

  it.each([actor(4), actor(5)])('rejects an unrelated or peer dealer write %j', async (editor) => {
    const f = fixture();
    await expect(f.service.saveForEstimate(20, { text: 'No', expectedVersion: 0 }, editor)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
  });

  it.each([actor(3, 'client'), actor(3, 'technician'), { id: 3 }])('rejects writing by an unsupported role %j', async (editor) => {
    const f = fixture();
    await expect(f.service.saveForEstimate(20, { text: 'No', expectedVersion: 0 }, editor)).rejects.toThrow();
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
    expect(f.db.estimateInternalNote.updateMany).not.toHaveBeenCalled();
  });

  it('returns not found for missing estimates and never creates an orphan note', async () => {
    const f = fixture();
    await expect(f.service.getForEstimate(999, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.saveForEstimate(999, { text: 'No', expectedVersion: 0 }, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
  });

  it.each(['paid', 'ordered', 'canceled'] as const)('edits a %s estimate note without touching its business records', async (state) => {
    const f = fixture();
    if (state === 'paid') f.estimate.payments = [{ id: 40, status: 'PAID', baseAmount: '214.00' }];
    if (state === 'ordered') f.estimate.order = { id: 50, status: 'Processing' };
    if (state === 'canceled') f.estimate.status = { name: 'Canceled' };
    const before = JSON.parse(JSON.stringify(f.estimate));
    await f.service.saveForEstimate(20, { text: 'Internal follow-up', expectedVersion: 0 }, actor(3));
    expect(f.estimate).toEqual(before);
    for (const model of [f.db.estimate, f.db.piece, f.db.payment, f.db.order, f.db.estimateAgreement]) {
      expect(model.update).not.toHaveBeenCalled();
      if (model.updateMany) expect(model.updateMany).not.toHaveBeenCalled();
    }
  });

  it('keeps the first new note when two editors both loaded no note', async () => {
    const f = fixture();
    await f.service.saveForEstimate(20, { text: 'First saved', expectedVersion: 0 }, actor(3));
    await expect(f.service.saveForEstimate(20, { text: 'Would overwrite', expectedVersion: 0 }, actor(2))).rejects.toBeInstanceOf(ConflictException);
    expect(f.storedNote()).toMatchObject({ text: 'First saved', version: 1, updatedById: 3 });
  });

  it('keeps the newer edit when two editors save the same loaded version', async () => {
    const f = fixture();
    f.seedNote();
    await f.service.saveForEstimate(20, { text: 'First change', expectedVersion: 1 }, actor(2));
    await expect(f.service.saveForEstimate(20, { text: 'Would overwrite', expectedVersion: 1 }, admin)).rejects.toBeInstanceOf(ConflictException);
    expect(f.storedNote()).toMatchObject({ text: 'First change', version: 2, updatedById: 2 });
  });

  it('does not recreate a missing note from a stale edit', async () => {
    const f = fixture();
    await expect(f.service.saveForEstimate(20, { text: 'Stale', expectedVersion: 2 }, actor(3))).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.estimateInternalNote.create).not.toHaveBeenCalled();
  });

  it('keeps author metadata safe when the author account was deleted', async () => {
    const f = fixture();
    f.seedNote({ updatedById: null });
    const result = await f.service.getForEstimate(20, operator);
    expect(result.internalNote?.updatedBy.id).toBeNull();
    expect(result.internalNote?.updatedBy.name).toEqual(expect.any(String));
    expect(result.internalNote?.text).toBe('Confirm the delivery entrance.');
  });

  it('uses the username when the author has no display name', async () => {
    const f = fixture();
    f.seedNote();
    f.users[2].firstName = '';
    f.users[2].lastName = '';
    expect((await f.service.getForEstimate(20, admin)).internalNote?.updatedBy.name).toBe('owner');
  });
});

describe('UpdateEstimateInternalNoteDto validation', () => {
  it.each([
    { text: '', expectedVersion: 0 },
    { text: 'Line one\nLine two', expectedVersion: 1 },
    { text: 'x'.repeat(2000), expectedVersion: 2147483646 },
  ])('accepts valid note input %j', async (input) => {
    expect(await validate(plainToInstance(UpdateEstimateInternalNoteDto, input))).toEqual([]);
  });

  it.each([
    { text: 'x'.repeat(2001), expectedVersion: 0 },
    { text: null, expectedVersion: 0 },
    { text: 123, expectedVersion: 0 },
    { expectedVersion: 0 },
    { text: 'Note' },
    { text: 'Note', expectedVersion: -1 },
    { text: 'Note', expectedVersion: 1.5 },
    { text: 'Note', expectedVersion: '1' },
    { text: 'Note', expectedVersion: null },
    { text: 'Note', expectedVersion: 2147483647 },
    { text: 'Note', expectedVersion: NaN },
    { text: 'Note', expectedVersion: Infinity },
  ])('rejects malformed or unsafe input %j', async (input) => {
    expect(await validate(plainToInstance(UpdateEstimateInternalNoteDto, input, { enableImplicitConversion: true }))).not.toHaveLength(0);
  });
});

describe('Estimate internal note API', () => {
  it('requires authenticated requests on both dedicated routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EstimateInternalNoteController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(PATH_METADATA, EstimateInternalNoteController)).toBe('estimates');
    expect(Reflect.getMetadata(PATH_METADATA, EstimateInternalNoteController.prototype.get)).toBe(':id/internal-note');
    expect(Reflect.getMetadata(METHOD_METADATA, EstimateInternalNoteController.prototype.get)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, EstimateInternalNoteController.prototype.save)).toBe(':id/internal-note');
    expect(Reflect.getMetadata(METHOD_METADATA, EstimateInternalNoteController.prototype.save)).toBe(RequestMethod.PATCH);
  });

  it('uses the authenticated actor rather than a body-supplied author or role', async () => {
    const notes: any = { getForEstimate: jest.fn(), saveForEstimate: jest.fn() };
    const controller = new EstimateInternalNoteController(notes);
    const req: any = { user: operator };
    const body: any = { text: 'Attempt', expectedVersion: 0, updatedById: admin.id, role: 'admin' };
    controller.get(20, req);
    controller.save(20, body, req);
    expect(notes.getForEstimate).toHaveBeenCalledWith(20, operator);
    expect(notes.saveForEstimate).toHaveBeenCalledWith(20, body, operator);
  });
});

import { InstallationPermitStatus, Prisma } from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';
import type { AuthUser } from '@/auth/types/auth-user.type';

const admin = { id: 1, role: { name: 'admin' } } as AuthUser;

function fixture(status: InstallationPermitStatus = 'PAID') {
  const permit = {
    id: 8,
    jobId: 3,
    status,
    cityFee: null as Prisma.Decimal | null,
    notes: null as string | null,
    submittedAt: status === 'PAID' ? null : new Date('2026-09-01T12:00:00Z'),
    approvedAt: status === 'APPROVED' ? new Date('2026-09-02T12:00:00Z') : null,
    updatedAt: new Date('2026-09-02T12:00:00Z'),
  };
  let jobStatus =
    status === 'APPROVED' ? 'MATERIAL_PAYMENT_PENDING' : 'PERMIT_PROCESSING';
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 7 }]),
    installationJob: {
      findUnique: jest.fn().mockResolvedValue({ estimateId: 7 }),
      update: jest.fn(async ({ data }) => {
        jobStatus = data.status;
      }),
    },
    installationPermit: {
      findUnique: jest.fn(async () => ({ ...permit })),
      update: jest.fn(async ({ data }) => {
        Object.assign(permit, data, { updatedAt: new Date() });
        if (data.cityFee !== undefined)
          permit.cityFee = new Prisma.Decimal(data.cityFee);
        return { ...permit };
      }),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    installationQuote: {
      findFirst: jest.fn().mockResolvedValue({ id: 4, status: 'APPROVED' }),
    },
    estimateAgreement: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // El bloqueo serializa los reintentos como la transacción real del estimado.
  let tail = Promise.resolve();
  const prisma = {
    ...db,
    $transaction: jest.fn((work) => {
      const result = tail.then(() => work(db));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  };
  const notifications = {
    createAndSend: jest.fn().mockResolvedValue(undefined),
  };
  const workflow = new InstallationWorkflowService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
  );
  jest.spyOn(workflow, 'findJob').mockImplementation(
    async () =>
      ({
        id: 3,
        estimateId: 7,
        estimate: { idUser: 9 },
        status: jobStatus,
        permit: { ...permit },
      }) as never,
  );
  return { workflow, db, permit, notifications };
}

describe('Permit processing and repeated saves', () => {
  it('submits a paid permit without a City Fee and ignores identical retries', async () => {
    const f = fixture();
    await f.workflow.updatePermit(3, { status: 'SUBMITTED' }, admin);
    const submittedAt = f.permit.submittedAt;
    await f.workflow.updatePermit(3, { status: 'SUBMITTED' }, admin);
    expect(f.permit.status).toBe('SUBMITTED');
    expect(f.permit.cityFee).toBeNull();
    expect(f.permit.submittedAt).toBe(submittedAt);
    expect(f.db.installationPermit.update).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
  });

  it('rejects entering City Fee when submitting the permit', async () => {
    const f = fixture();
    await expect(
      f.workflow.updatePermit(3, { status: 'SUBMITTED', cityFee: 300 }, admin),
    ).rejects.toThrow('only be entered');
    expect(f.db.installationPermit.update).not.toHaveBeenCalled();
  });

  it('requires submission before approval', async () => {
    const f = fixture();
    await expect(
      f.workflow.updatePermit(3, { status: 'APPROVED', cityFee: 300 }, admin),
    ).rejects.toThrow('PAID to APPROVED');
    expect(f.db.installationPermit.update).not.toHaveBeenCalled();
  });

  it.each([undefined, null, -1, Number.NaN])(
    'rejects approval with invalid City Fee %s',
    async (cityFee) => {
      const f = fixture('SUBMITTED');
      await expect(
        f.workflow.updatePermit(3, { status: 'APPROVED', cityFee }, admin),
      ).rejects.toThrow('valid City Fee');
      expect(f.db.installationPermit.update).not.toHaveBeenCalled();
      expect(f.notifications.createAndSend).not.toHaveBeenCalled();
    },
  );

  it.each([0, 300])(
    'approves with City Fee %s only once for simultaneous saves',
    async (cityFee) => {
      const f = fixture('SUBMITTED');
      const dto = { status: 'APPROVED' as const, cityFee, notes: '  Ready  ' };
      await Promise.all([
        f.workflow.updatePermit(3, dto, admin),
        f.workflow.updatePermit(3, dto, admin),
      ]);
      expect(f.permit.status).toBe('APPROVED');
      expect(f.permit.cityFee?.toNumber()).toBe(cityFee);
      expect(f.permit.notes).toBe('Ready');
      expect(f.permit.approvedAt).toBeInstanceOf(Date);
      expect(f.db.installationPermit.update).toHaveBeenCalledTimes(1);
      expect(f.db.installationJob.update).toHaveBeenCalledTimes(1);
      expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
    },
  );

  it('allows correcting City Fee and notes before checkout without changing the approval date', async () => {
    const f = fixture('APPROVED');
    f.permit.cityFee = new Prisma.Decimal(300);
    f.permit.notes = 'Old note';
    const approvedAt = f.permit.approvedAt;
    await f.workflow.updatePermit(
      3,
      { status: 'APPROVED', cityFee: 320, notes: '' },
      admin,
    );
    await f.workflow.updatePermit(
      3,
      { status: 'APPROVED', cityFee: 320, notes: ' ' },
      admin,
    );
    expect(f.permit.cityFee.toNumber()).toBe(320);
    expect(f.permit.notes).toBeNull();
    expect(f.permit.approvedAt).toBe(approvedAt);
    expect(f.db.installationPermit.update).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).toHaveBeenCalledTimes(1);
  });

  it('preserves submission date when only notes change', async () => {
    const f = fixture('SUBMITTED');
    const submittedAt = f.permit.submittedAt;
    await f.workflow.updatePermit(
      3,
      { status: 'SUBMITTED', notes: 'Updated' },
      admin,
    );
    expect(f.permit.submittedAt).toBe(submittedAt);
    expect(f.permit.notes).toBe('Updated');
  });

  it.each(['SUBMITTED', 'CHANGES_REQUIRED', 'REJECTED'] as const)(
    'cannot move an approved permit to %s',
    async (status) => {
      const f = fixture('APPROVED');
      f.permit.cityFee = new Prisma.Decimal(300);
      await expect(
        f.workflow.updatePermit(3, { status }, admin),
      ).rejects.toThrow(`APPROVED to ${status}`);
      expect(f.db.installationPermit.update).not.toHaveBeenCalled();
    },
  );

  it('keeps City Fee locked after material checkout starts', async () => {
    const f = fixture('APPROVED');
    f.permit.cityFee = new Prisma.Decimal(300);
    f.db.payment.findFirst.mockResolvedValue({ id: 12 });
    await expect(
      f.workflow.updatePermit(3, { status: 'APPROVED', cityFee: 320 }, admin),
    ).rejects.toThrow('frozen');
    expect(f.permit.cityFee.toNumber()).toBe(300);
    expect(f.db.installationPermit.update).not.toHaveBeenCalled();
  });
});

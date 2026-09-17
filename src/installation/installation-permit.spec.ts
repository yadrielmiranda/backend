import { InstallationPermitStatus, Prisma } from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';
import { planRows, PlanSnapshot } from '@/payment-plans/payment-plan';
import type { AuthUser } from '@/auth/types/auth-user.type';

const admin = { id: 1, role: { name: 'admin' } } as AuthUser;

function fixture(status: InstallationPermitStatus = 'PAID', planned = false) {
  const permit = {
    id: 8,
    jobId: 3,
    status,
    permitFeeSnapshot: '1500.00',
    cityFee: null as Prisma.Decimal | null,
    notes: null as string | null,
    submittedAt: status === 'PAID' ? null : new Date('2026-09-01T12:00:00Z'),
    approvedAt: status === 'APPROVED' ? new Date('2026-09-02T12:00:00Z') : null,
    updatedAt: new Date('2026-09-02T12:00:00Z'),
  };
  let jobStatus =
    status === 'APPROVED' ? 'MATERIAL_PAYMENT_PENDING' : 'PERMIT_PROCESSING';
  const snapshot: PlanSnapshot = { version: 1, planId: 1, name: '50/40/10', definition: {
    withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 50 }, { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 }, { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 }],
    withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }],
  } };
  const amounts = { material: '8000.00', installation: '2000.00', permit: '1500.00', city: '0.00' };
  snapshot.locked = { amounts, rows: planRows(snapshot, amounts, true), at: new Date().toISOString() };
  if (planned) jobStatus = 'MATERIAL_PAID';
  const estimate: any = { id: 7, idUser: 9, number: '190999', units: 2, totalPayable: '8000.00', status: { name: 'Ordered' },
    order: { id: 10, status: { name: 'Pending' } },
    paymentPlanSnapshot: planned ? snapshot : null,
    payments: planned ? [{ id: 12, type: 'INSTALLMENT', sequence: 1, status: 'PAID', baseAmount: '5750.00' }] : [],
    installationJob: { id: 3, get status() { return jobStatus; }, permit, quotes: [{ status: 'APPROVED', total: '2000.00' }], appointments: [] },
  };
  const db = {
    $queryRaw: jest.fn(async () => [{ id: 7, paymentPlanSnapshot: estimate.paymentPlanSnapshot }]),
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
    estimate: { findFirst: jest.fn(async () => estimate), findUnique: jest.fn(async () => estimate), update: jest.fn(async ({ data }) => Object.assign(estimate, data)) },
    payment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
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
        estimate,
        paymentSchedule: buildPaymentSchedule(estimate),
        status: jobStatus,
        permit: { ...permit },
      }) as never,
  );
  return { workflow, db, permit, notifications, estimate };
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


describe('Permits in a project payment plan', () => {
  it('allows processing the included Permit Fee without a separate permit payment', async () => {
    const f = fixture('PAYMENT_PENDING', true);
    await f.workflow.updatePermit(3, { status: 'SUBMITTED' }, admin);
    expect(f.permit.status).toBe('SUBMITTED');
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    expect(f.db.installationJob.update).not.toHaveBeenCalled();
    expect(f.estimate.payments).toHaveLength(1);
  });

  it('adds a late City Fee once inside the permit transaction without resetting the order stage', async () => {
    const f = fixture('SUBMITTED', true);
    const originalRows = structuredClone(f.estimate.paymentPlanSnapshot.locked.rows);
    await Promise.all([
      f.workflow.updatePermit(3, { status: 'APPROVED', cityFee: 300 }, admin),
      f.workflow.updatePermit(3, { status: 'APPROVED', cityFee: 300 }, admin),
    ]);
    expect(f.estimate.paymentPlanSnapshot.adjustments).toHaveLength(1);
    expect(f.estimate.paymentPlanSnapshot.adjustments[0]).toMatchObject({ kind: 'CITY_FEE', amount: '300.00' });
    expect(f.estimate.paymentPlanSnapshot.locked.rows).toEqual(originalRows);
    expect(f.estimate.installationJob.status).toBe('MATERIAL_PAID');
    expect(f.db.installationPermit.update).toHaveBeenCalledTimes(1);
    expect(buildPaymentSchedule(f.estimate)?.next?.title).toBe('City Fee adjustment');
  });

  it('does not change a City Fee while a checkout is open', async () => {
    const f = fixture('SUBMITTED', true);
    f.db.payment.findFirst.mockResolvedValue({ id: 99 });
    await expect(f.workflow.updatePermit(3, { status: 'APPROVED', cityFee: 300 }, admin)).rejects.toThrow('Cancel the open checkout');
    expect(f.db.installationPermit.update).not.toHaveBeenCalled();
    expect(f.permit.cityFee).toBeNull();
  });

  it('keeps fabrication approval separate from permission to start a managed-permit installation', async () => {
    const f = fixture('SUBMITTED', true);
    f.estimate.paymentPlanSnapshot = null;
    f.estimate.order = { id: 10, status: { name: 'Ready to pick up' }, fulfillmentMethod: 'INSTALLATION_DELIVERY', deliveries: [] };
    jest.spyOn(f.workflow, 'findJob').mockResolvedValue({ id: 3, estimateId: 7, status: 'SCHEDULED', estimate: f.estimate,
      quotes: [{ status: 'APPROVED', total: '2000.00' }], payments: [{ type: 'INSTALLATION', status: 'PAID', baseAmount: '2000.00' }],
    } as never);
    await expect(f.workflow.startJob(3, admin)).rejects.toThrow('company-managed permit must be approved');
    expect(f.db.installationJob.update).not.toHaveBeenCalled();
  });
});

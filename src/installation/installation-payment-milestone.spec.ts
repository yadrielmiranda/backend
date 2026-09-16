import type { AuthUser } from '@/auth/types/auth-user.type';
import { PlanSnapshot, planRows } from '@/payment-plans/payment-plan';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';
import { InstallationWorkflowService } from './installation-workflow.service';
import { InstallationAppointmentResponse } from './dto/installation-workflow.dto';

const admin = { id: 1, role: { name: 'admin' } } as AuthUser;

// Reproduce la orden con City Fee pendiente y las cuotas 50/40 ya pagadas.
function fixture(releasePaid = true) {
  const amounts = { material: '435.06', installation: '450.00', permit: '1500.00', city: '0.00' };
  const snapshot: PlanSnapshot = {
    version: 1, planId: 2, name: '50/40/10',
    definition: {
      withInstallation: [
        { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
        { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
        { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
      ],
      withoutInstallation: [{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }],
    },
  };
  snapshot.locked = { amounts, rows: planRows(snapshot, amounts, true), at: '2026-09-16' };
  snapshot.adjustments = [{ sequence: 101, kind: 'CITY_FEE', milestone: 'ORDER', title: 'City Fee adjustment', description: '', amount: '200.00', amounts: { ...amounts, city: '200.00' } }];
  const payments: any[] = [
    { type: 'INSTALLATION_DEPOSIT', status: 'PAID', sequence: 1, baseAmount: '250.00' },
    { type: 'INSTALLMENT', status: 'PAID', sequence: 1, baseAmount: '942.53' },
  ];
  if (releasePaid) payments.push({ type: 'INSTALLMENT', status: 'PAID', sequence: 2, baseAmount: '954.02' });
  const estimate: any = {
    id: 32, idUser: 7, number: '190932', units: 2,
    totalPayable: amounts.material, paymentPlanSnapshot: snapshot, payments,
    status: { name: 'Ordered' },
    order: { id: 12, number: 'ORD-1012', status: { name: 'Ready to pick up' }, fulfillmentMethod: 'INSTALLATION_DELIVERY', deliveries: [] },
  };
  const job: any = {
    id: 20, estimateId: 32, estimate, status: 'INSTALLATION_PAYMENT_PENDING',
    quotes: [{ id: 1, version: 1, status: 'APPROVED', total: amounts.installation }],
    permit: { status: 'APPROVED', permitFeeSnapshot: amounts.permit, cityFee: '200.00' },
    payments, appointments: [], revisions: [],
  };
  estimate.installationJob = job;
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: estimate.id, paymentPlanSnapshot: snapshot }]),
    estimate: { findUnique: jest.fn(async () => estimate) },
    installationJob: {
      findUnique: jest.fn(async () => job),
      update: jest.fn(async ({ data }) => Object.assign(job, data)),
    },
    installationAppointment: {
      findMany: jest.fn(async () => job.appointments),
      findUnique: jest.fn(async ({ where }) => ({ ...job.appointments.find(ap => ap.id === where.id), job })),
      create: jest.fn(async ({ data }) => {
        const appointment = { id: 31, status: 'PROPOSED', ...data };
        job.appointments.push(appointment);
        return appointment;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(job.appointments.find(ap => ap.id === where.id), data)),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    installationPermit: { findUnique: jest.fn(async () => job.permit) },
    orderStatus: { findUnique: jest.fn(async () => ({ id: 6, name: 'Installation in progress' })) },
    order: { update: jest.fn(async () => Object.assign(estimate.order, { status: { name: 'Installation in progress' } })) },
    eventLog: { create: jest.fn() },
    estimateAgreement: { findMany: jest.fn(async () => []) },
  };
  tx.$transaction = jest.fn(async work => work(tx));
  const notifications = { createAndSend: jest.fn(), createAndSendToRoles: jest.fn() };
  const workflow = new InstallationWorkflowService(tx, {} as never, {} as never, {} as never, {} as never, notifications as never);
  return { job, estimate, tx, workflow, notifications };
}

describe('Installation scheduling follows the payment plan', () => {
  it.each(['job', 'estimate'])('reconciles an already blocked installation when opened through %s', async route => {
    const f = fixture();
    const result = route === 'job'
      ? await f.workflow.findJob(20, admin)
      : await f.workflow.findJobByEstimate(32, admin);
    expect(result?.status).toBe('INSTALLATION_PAID');
    expect(result?.paymentSchedule).toMatchObject({ canInstall: true, paid: '2146.55', balance: '438.51' });
    expect(result?.paymentSchedule?.next).toMatchObject({ kind: 'CITY_FEE', balance: '200.00', status: 'DUE' });
    expect(f.tx.installationJob.update).toHaveBeenCalledTimes(1);
    await f.workflow.findJob(20, admin);
    expect(f.tx.installationJob.update).toHaveBeenCalledTimes(1);
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it('proposes, accepts and starts installation while City Fee remains payable', async () => {
    const f = fixture();
    await f.workflow.proposeAppointment(20, { type: 'INSTALLATION', startsAt: '2026-09-25T13:00:00Z' }, admin);
    expect(f.job.status).toBe('SCHEDULING');
    await f.workflow.respondAppointment(31, { response: InstallationAppointmentResponse.ACCEPT }, { id: 7, role: { name: 'client' } } as AuthUser);
    expect(f.job.status).toBe('SCHEDULED');
    await f.workflow.startJob(20, admin);
    expect(f.job.status).toBe('IN_PROGRESS');
    expect(f.estimate.order.status.name).toBe('Installation in progress');
    expect(buildPaymentSchedule(f.estimate)?.next).toMatchObject({ kind: 'CITY_FEE', balance: '200.00', status: 'DUE' });
    expect(buildPaymentSchedule(f.estimate)?.rows.find(row => row.sequence === 3)?.status).toBe('UPCOMING');
    expect(f.estimate.payments).toHaveLength(3);
  });

  it('keeps scheduling and starting blocked when the required release installment is unpaid', async () => {
    const f = fixture(false);
    expect((await f.workflow.findJob(20, admin)).status).toBe('INSTALLATION_PAYMENT_PENDING');
    await expect(f.workflow.proposeAppointment(20, { type: 'INSTALLATION', startsAt: '2026-09-25T13:00:00Z' }, admin)).rejects.toThrow('paid before scheduling');
    f.job.status = 'SCHEDULED';
    await expect(f.workflow.startJob(20, admin)).rejects.toThrow('installments required before installation');
    expect(f.tx.installationAppointment.create).not.toHaveBeenCalled();
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });

  it('keeps the managed permit approval requirement before installation starts', async () => {
    const f = fixture();
    f.job.status = 'SCHEDULED';
    f.job.permit.status = 'SUBMITTED';
    await expect(f.workflow.startJob(20, admin)).rejects.toThrow('permit must be approved');
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });

  it('checks access before reconciling a blocked job', async () => {
    const f = fixture();
    await expect(f.workflow.findJob(20, { id: 99, role: { name: 'client' } } as AuthUser)).rejects.toThrow('not found');
    expect(f.tx.$transaction).not.toHaveBeenCalled();
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
  });
});

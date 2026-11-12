import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InstallationPricingService } from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';

const admin = { id: 1, role: { name: 'admin' } } as const;
const owner = { id: 7, role: { name: 'dealer' } } as const;
const address = { street: '123 Example Street', city: 'Miami', state: 'FL', postalCode: '33101' };
const request = {
  installationAddress: address,
  installationAddressConfirmed: true,
  permitRequested: false,
  selectedServices: [{ serviceId: 5, occurrences: 2, description: 'Owner service note' }],
};
const dec = (value: number) => new Prisma.Decimal(value);

function fixture() {
  const estimate: any = {
    id: 2, idUser: owner.id, number: '190001', status: { name: 'Active' },
    user: { id: owner.id, role: owner.role }, order: null, payments: [], manualDiscount: null,
  };
  const quote: any = {
    id: 11, jobId: 3, version: 1, status: 'DRAFT', total: dec(500), lines: [],
    profileId: 9, profileNameSnapshot: 'Owner pricing', profileAdjustmentPercent: dec(80),
    profileMinimumSnapshot: dec(500), profileRateAdjustmentsSnapshot: {
      schema: 1, adjustments: [{ serviceId: 5, ruleId: null, type: 'PERCENT', value: '20' }],
    },
    job: { installationAddressConfirmedAt: new Date(0) },
    coverageSnapshot: { data: { schema: 1, revision: 1, range: { type: 'FIXED', value: '0' } } },
  };
  const job: any = {
    id: 3, estimateId: estimate.id, estimate, status: 'DEPOSIT_PAYMENT_PENDING',
    installationAddress: address, installationAddressConfirmedAt: new Date(0),
    depositAmountSnapshot: dec(250), dealerMeasurementsAcceptedAt: null,
    quotes: [quote], payments: [], permit: null, revisions: [], measurements: [],
  };
  const service = {
    id: 5, name: 'Selected service', billingUnit: 'UNIT', ruleMetric: 'NONE',
    baseRate: dec(100), minimumCharge: dec(0), estimatedMinutes: dec(15), rules: [],
    isActive: true, availableForRequest: true, availableForField: true,
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: estimate.id }]),
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    estimate: { findUnique: jest.fn(async () => estimate) },
    estimateAgreement: { findMany: jest.fn().mockResolvedValue([]) },
    installationJob: {
      findUnique: jest.fn(async () => job),
      update: jest.fn(async ({ data }) => Object.assign(job, data)),
      delete: jest.fn(),
    },
    installationQuote: {
      findUnique: jest.fn(async () => quote),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }) => Object.assign(quote, data)),
    },
    installationQuoteCoverageSnapshot: {
      findUnique: jest.fn(async () => quote.coverageSnapshot),
      upsert: jest.fn(async ({ update }) => { quote.coverageSnapshot = update; }),
    },
    installationQuoteLine: {
      aggregate: jest.fn(async () => ({ _max: { sortOrder: -1 } })),
      create: jest.fn(async ({ data }) => {
        const line = { ...data, id: 20, service };
        quote.lines.push(line);
        return line;
      }),
      deleteMany: jest.fn(async () => { quote.lines = []; }),
      count: jest.fn(async () => quote.lines.length),
    },
    installationService: { findUnique: jest.fn(async () => service) },
    installationAppointment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (work) => work(tx)) };
  const pricing = new InstallationPricingService(prisma as never);
  const resolveProfile = jest.spyOn(pricing, 'resolveProfileForUser');
  const logs = { log: jest.fn() };
  const notifications = { createAndSend: jest.fn(), createAndSendToRoles: jest.fn() };
  const workflow = new InstallationWorkflowService(prisma as never, pricing, logs as never,
    {} as never, {} as never, notifications as never);
  // Exercise authorization, request mutations and pricing; presentation is unrelated.
  jest.spyOn(workflow as any, 'presentJob').mockImplementation(async (record) => record);
  return { workflow, estimate, job, quote, tx, prisma, logs, notifications, resolveProfile };
}

describe('Preliminary installation request management', () => {
  it.each([['non-owner admin', admin], ['estimate owner', owner]] as const)(
    'allows the %s to edit with the saved owner profile and remove before payment', async (_, actor) => {
      const f = fixture();
      await f.workflow.updateInstallationRequest(f.job.id, request, actor);

      expect(f.quote.lines[0].baseAmount.toFixed(2)).toBe('200.00');
      expect(f.quote.lines[0].adjustedAmount.toFixed(2)).toBe('240.00');
      expect(f.quote.lines[0].description).toBe('Owner service note');
      expect(f.quote.total.toFixed(2)).toBe('540.00');
      expect(f.quote.profileId).toBe(9);
      expect(f.quote.profileNameSnapshot).toBe('Owner pricing');
      expect(f.quote.profileMinimumSnapshot.toFixed(2)).toBe('500.00');
      expect(f.resolveProfile).not.toHaveBeenCalled();
      expect(f.tx.user.findUnique).not.toHaveBeenCalled();
      expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE', userId: actor.id }));

      await expect(f.workflow.cancelInstallation(f.job.id, {}, actor)).resolves.toBeNull();
      expect(f.tx.installationJob.delete).toHaveBeenCalledWith({ where: { id: f.job.id } });
      expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE', userId: actor.id }));
    },
  );

  it('uses the customer owner rules for service descriptions when an admin edits', async () => {
    const f = fixture();
    f.estimate.user.role = { name: 'client' };
    await f.workflow.updateInstallationRequest(f.job.id, request, admin);
    expect(f.quote.lines[0].description).toBeNull();
    expect(f.quote.total.toFixed(2)).toBe('540.00');
  });

  it.each(['dealer', 'client', 'operator'] as const)(
    'denies an unrelated %s without changing the request', async (role) => {
      const f = fixture();
      const actor = { id: 99, role: { name: role } };
      await expect(f.workflow.updateInstallationRequest(f.job.id, request, actor)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.workflow.cancelInstallation(f.job.id, {}, actor)).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
      expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['material checkout', { type: 'MATERIAL', status: 'PENDING', stripeSessionId: 'cs_started' }],
    ['permit payment', { type: 'PERMIT', status: 'PAID' }],
    ['refunded payment', { type: 'MATERIAL', status: 'REFUNDED' }],
    ['recorded payment', { type: 'MATERIAL', status: 'CANCELED', paidAt: new Date(0) }],
    ['canceled checkout with a session', { type: 'MATERIAL', status: 'CANCELED', stripeSessionId: 'cs_saved' }],
  ])('blocks admin edits after %s, including estimate-only payments', async (_, payment) => {
    const f = fixture();
    f.estimate.payments.push(payment);
    await expect(f.workflow.updateInstallationRequest(f.job.id, request, admin)).rejects.toThrow('before payment starts');
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it.each(['MATERIAL', 'PERMIT'].flatMap(type => [
    { label: `${type} checkout`, type, status: 'PENDING', stripeSessionId: 'cs_started' },
    { label: `${type} paid`, type, status: 'PAID' },
    { label: `${type} refunded`, type, status: 'REFUNDED' },
    { label: `${type} recorded payment`, type, status: 'CANCELED', paidAt: new Date(0) },
    { label: `${type} canceled checkout`, type, status: 'CANCELED', stripeSessionId: 'cs_saved' },
  ]))('blocks preliminary admin removal after estimate-only $label', async ({ label, ...payment }) => {
    const f = fixture();
    f.estimate.payments.push(payment);
    await expect(f.workflow.cancelInstallation(f.job.id, {}, admin)).rejects.toThrow('before payment starts');
    expect(f.job.payments).toEqual([]);
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    expect(f.logs.log).not.toHaveBeenCalled();
  });

  it('also prevents the owner from removing preliminary installation after project checkout starts', async () => {
    const f = fixture();
    f.estimate.payments.push({ type: 'MATERIAL', status: 'PENDING', stripeSessionId: 'cs_started' });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, owner)).rejects.toThrow('before payment starts');
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it.each(['MATERIAL', 'PERMIT'])('rechecks estimate-only %s checkout under the transaction before admin removal', async (type) => {
    const f = fixture();
    f.prisma.$transaction.mockImplementationOnce(async (work) => {
      f.estimate.payments.push({ type, status: 'PENDING', stripeSessionId: 'cs_started' });
      return work(f.tx);
    });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, admin)).rejects.toThrow('before payment starts');
    expect(f.job.payments).toEqual([]);
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it('rechecks payment start under the transaction before admin editing', async () => {
    const f = fixture();
    f.prisma.$transaction.mockImplementationOnce(async (work) => {
      f.estimate.payments.push({ type: 'MATERIAL', status: 'PENDING', stripeSessionId: 'cs_started' });
      return work(f.tx);
    });
    await expect(f.workflow.updateInstallationRequest(f.job.id, request, admin)).rejects.toThrow('before payment starts');
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it('blocks admin removal while an installation deposit checkout is open', async () => {
    const f = fixture();
    f.job.payments.push({ type: 'INSTALLATION_DEPOSIT', status: 'PENDING', stripeSessionId: 'cs_started' });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, admin)).rejects.toThrow('Cancel the active');
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it('rechecks installation deposit checkout before admin removal', async () => {
    const f = fixture();
    f.prisma.$transaction.mockImplementationOnce(async (work) => {
      f.job.payments.push({ type: 'INSTALLATION_DEPOSIT', status: 'PENDING', stripeSessionId: 'cs_started' });
      return work(f.tx);
    });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, admin)).rejects.toThrow('payments changed');
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it.each(['closed', 'ordered'])('blocks admin editing of a %s estimate', async (state) => {
    const f = fixture();
    if (state === 'closed') f.estimate.status.name = 'Closed';
    else f.estimate.order = { id: 15 };
    await expect(f.workflow.updateInstallationRequest(f.job.id, request, admin)).rejects.toThrow();
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  });

  it('allows removal with an unused canceled payment', async () => {
    const f = fixture();
    f.estimate.payments.push({ type: 'MATERIAL', status: 'CANCELED', stripeSessionId: null });
    await expect(f.workflow.cancelInstallation(f.job.id, {}, admin)).resolves.toBeNull();
  });
});

describe('Admin cancellation after the installation deposit is paid', () => {
  it('retains the record and payment, stores the reason and cancels appointments', async () => {
    const f = fixture();
    f.job.status = 'MEASUREMENT_SCHEDULING';
    const deposit = { id: 51, type: 'INSTALLATION_DEPOSIT', status: 'PAID', amount: dec(250), paidAt: new Date(0) };
    f.job.payments.push(deposit);
    f.estimate.payments.push(deposit, { type: 'MATERIAL', status: 'PAID' });
    const paymentBefore = { ...deposit };

    const result = await f.workflow.cancelInstallation(f.job.id, { reason: '  Customer changed scope  ' }, admin);

    expect(result).toMatchObject({ id: f.job.id, status: 'CANCELED', cancellationReason: 'Customer changed scope' });
    expect(result.canceledAt).toBeInstanceOf(Date);
    expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
    expect(f.job.payments).toEqual([paymentBefore]);
    expect(f.tx.installationAppointment.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: f.job.id,
        status: { in: ['PROPOSED', 'ACCEPTED', 'RESCHEDULE_REQUESTED'] },
      },
      data: { status: 'CANCELED' },
    });
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE', entityId: f.job.id, userId: admin.id,
      after: { status: 'CANCELED', cancellationReason: 'Customer changed scope' },
    }));
    expect(f.notifications.createAndSend).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: owner.id, actorId: admin.id,
    }));
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'BALANCE_PAID', 'PLACED_ORDER', 'ACTIVE_CHECKOUT'])(
    'preserves the existing %s cancellation restriction', async (restriction) => {
      const f = fixture();
      f.job.status = 'MEASUREMENT_SCHEDULING';
      f.job.payments.push({ type: 'INSTALLATION_DEPOSIT', status: 'PAID' });
      if (restriction === 'IN_PROGRESS' || restriction === 'COMPLETED') f.job.status = restriction;
      if (restriction === 'BALANCE_PAID') f.job.payments.push({ type: 'INSTALLATION', status: 'PAID' });
      if (restriction === 'PLACED_ORDER') {
        f.estimate.paymentPlanSnapshot = { version: 1 };
        f.estimate.order = { id: 10 };
      }
      if (restriction === 'ACTIVE_CHECKOUT') f.job.payments.push({ type: 'INSTALLATION', status: 'PENDING', stripeSessionId: 'cs_started' });

      await expect(f.workflow.cancelInstallation(f.job.id, { reason: 'Canceled by admin' }, admin)).rejects.toThrow();
      expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
      expect(f.tx.installationAppointment.updateMany).not.toHaveBeenCalled();
    },
  );
});

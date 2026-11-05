import { InstallationJobStatus, PaymentType } from '@prisma/client';
import { EstimatesService } from './estimates.service';

function fixture() {
  let state: any = {
    estimate: {
      id: 1, number: '190936', idUser: 7,
      status: { name: 'Active' }, order: null, payments: [],
      pieces: [{ id: 2, qty: 1, mark: 'W1' }],
    },
    installation: {
      id: 10, status: 'DEPOSIT_PAYMENT_PENDING',
      dealerMeasurementsAcceptedAt: null,
      _count: { quotes: 1 },
      quotes: [{ status: 'DRAFT', approvalReason: 'REMEASUREMENT', submittedAt: null }],
    },
    agreements: [], audit: [],
  };
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: 1 }]),
    estimate: {
      findUnique: jest.fn(async () => state.estimate && {
        ...state.estimate, installationJob: state.installation,
      }),
      delete: jest.fn(async () => {
        const old = state.estimate;
        state.estimate = null;
        return old;
      }),
    },
    installationJob: {
      delete: jest.fn(async () => {
        const old = state.installation;
        state.installation = null;
        return old;
      }),
    },
    piece: { deleteMany: jest.fn(async () => { state.estimate.pieces = []; }) },
    estimateAgreement: {
      count: jest.fn(async () => state.agreements.filter((a: any) => a.signedAt).length),
      findMany: jest.fn(async () => state.agreements.filter((a: any) => !a.signedAt)),
      deleteMany: jest.fn(async () => {
        state.agreements = state.agreements.filter((a: any) => a.signedAt);
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (work: (db: any) => Promise<unknown>) => {
      const before = structuredClone(state);
      try { return await work(tx); }
      catch (error) { state = before; throw error; }
    }),
  };
  const logs = { log: jest.fn(async (event: any, db: any) => {
    expect(db).toBe(tx);
    state.audit.push(event);
  }) };
  const service = new EstimatesService(
    prisma as any, logs as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { state: () => state, tx, prisma, logs, service };
}

function waiveDeposit(f: ReturnType<typeof fixture>, status = 'MATERIAL_PAYMENT_PENDING') {
  Object.assign(f.state().installation, {
    status, dealerMeasurementsAcceptedAt: new Date('2026-11-01'),
    quotes: [{ status: 'APPROVED', approvalReason: 'DEALER_MEASUREMENTS', submittedAt: null }],
  });
}

async function expectBlocked(f: ReturnType<typeof fixture>, message: string) {
  const before = structuredClone(f.state());
  await expect(f.service.deleteEstimate({ id: 1 }, 7)).rejects.toThrow(message);
  expect(f.state()).toEqual(before);
  expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
  expect(f.tx.piece.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.estimate.delete).not.toHaveBeenCalled();
  expect(f.tx.estimateAgreement.deleteMany).not.toHaveBeenCalled();
  expect(f.logs.log).not.toHaveBeenCalled();
}

describe('Estimate deletion with a calculated installation', () => {
  it('deletes the preliminary installation and estimate in one locked transaction', async () => {
    const f = fixture();
    const deleted = await f.service.deleteEstimate({ id: 1 }, 7);
    expect(deleted.id).toBe(1);
    expect(f.state()).toMatchObject({ estimate: null, installation: null });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.estimate.findUnique.mock.invocationCallOrder[0],
    );
    expect(f.tx.installationJob.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(f.tx.estimate.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'DELETE', entityType: 'Estimate', entityId: 1, userId: 7,
      meta: { source: 'EstimatesService.deleteEstimate', installationJobId: 10 },
    }), f.tx);
    expect(f.state().audit).toHaveLength(1);
    const query = f.tx.estimate.findUnique.mock.calls[0][0];
    expect(query.include.payments.include.receipts).toEqual({ select: { id: true } });
    expect(query.include.installationJob.select.quotes).toMatchObject({
      orderBy: { version: 'desc' }, take: 1,
    });
    expect(query.include.installationJob.select.quotes).not.toHaveProperty('where');
  });

  it.each(['PENDING', 'CANCELED'])('allows an unpaid %s payment record without a checkout', async status => {
    const f = fixture();
    f.state().estimate.payments = [{ type: 'INSTALLATION_DEPOSIT', status, baseAmount: '500' }];
    await f.service.deleteEstimate({ id: 1 }, 7);
    expect(f.state().estimate).toBeNull();
    expect(f.state().installation).toBeNull();
  });

  it.each([null, 'CANCELED'])('preserves deletion without an active installation: %s', async status => {
    const f = fixture();
    if (status) f.state().installation.status = status;
    else f.state().installation = null;
    await f.service.deleteEstimate({ id: 1 }, 7);
    expect(f.state().estimate).toBeNull();
    expect(f.tx.installationJob.delete).toHaveBeenCalledTimes(status ? 1 : 0);
  });

  it.each(['MATERIAL_PAYMENT_PENDING', 'PERMIT_PAYMENT_PENDING'])(
    'deletes the initial calculation with a waived deposit in %s', async status => {
      const f = fixture();
      waiveDeposit(f, status);
      await f.service.deleteEstimate({ id: 1 }, 7);
      expect(f.state().estimate).toBeNull();
      expect(f.state().installation).toBeNull();
    },
  );

  it.each(Object.values(InstallationJobStatus).filter(status =>
    !['DEPOSIT_PAYMENT_PENDING', 'CANCELED'].includes(status),
  ))('keeps installations beyond the initial calculation: %s', async status => {
    const f = fixture();
    f.state().installation.status = status;
    await expectBlocked(f, 'installation workflow is active');
  });

  it.each([
    { label: 'later quote version', mutate: (job: any) => { job._count.quotes = 2; } },
    { label: 'submitted quote', mutate: (job: any) => { job.quotes[0].submittedAt = new Date(); } },
    { label: 'field change', mutate: (job: any) => { job.quotes[0].approvalReason = 'FIELD_CHANGE'; } },
    { label: 'rejected quote', mutate: (job: any) => { job.quotes[0].status = 'REJECTED'; } },
    { label: 'missing acceptance', mutate: (job: any) => { job.dealerMeasurementsAcceptedAt = null; } },
  ])('does not discard a waived installation with $label', async ({ mutate }) => {
    const f = fixture();
    waiveDeposit(f);
    mutate(f.state().installation);
    await expectBlocked(f, 'installation workflow is active');
  });

  it.each([
    { status: 'PAID' },
    { status: 'REFUNDED' },
    { paidAt: new Date('2026-11-01') },
    { receipts: [{ id: 4 }] },
    { netPaidBaseAmount: '0.01' },
    { netPaidBaseAmount: '0', refundedAmount: '100' },
    { refundCreditAmount: '1' },
    { refundReviewPending: true },
    { stripeSessionId: 'cs_open' },
    { stripePaymentIntentId: 'pi_processing' },
  ])('preserves payment history or payment attempts: %j', async payment => {
    const f = fixture();
    f.state().estimate.payments = [{ type: 'INSTALLATION_DEPOSIT', status: 'PENDING', ...payment }];
    await expectBlocked(f, 'payment process has already started');
  });

  it.each(Object.values(PaymentType))(
    'checks every payment, including a later %s payment', async type => {
      const f = fixture();
      f.state().estimate.payments = [
        { type: 'INSTALLMENT', sequence: 1, status: 'CANCELED' },
        { type, sequence: 2, status: 'PENDING', stripeSessionId: 'cs_open' },
      ];
      await expectBlocked(f, 'payment process has already started');
    },
  );

  it.each(['order', 'canceled', 'signed agreement', 'missing estimate'])(
    'keeps the existing restriction for %s', async restriction => {
      const f = fixture();
      let message = restriction;
      if (restriction === 'order') f.state().estimate.order = { id: 30 };
      if (restriction === 'canceled') f.state().estimate.status.name = 'Canceled';
      if (restriction === 'signed agreement') f.state().agreements.push({ signedAt: new Date() });
      if (restriction === 'missing estimate') { f.state().estimate = null; message = 'not found'; }
      await expectBlocked(f, message);
    },
  );

  it.each(['estimate deletion', 'audit write'])('rolls back both deletions if %s fails', async failure => {
    const f = fixture();
    const before = structuredClone(f.state());
    if (failure === 'estimate deletion') {
      f.tx.estimate.delete.mockRejectedValueOnce(new Error('Delete failed'));
    } else {
      f.logs.log.mockImplementationOnce(async (event: any, db: any) => {
        expect(db).toBe(f.tx);
        f.state().audit.push(event);
        throw new Error('Audit failed');
      });
    }
    await expect(f.service.deleteEstimate({ id: 1 }, 7)).rejects.toThrow('failed');
    expect(f.tx.installationJob.delete).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual(before);
  });
});

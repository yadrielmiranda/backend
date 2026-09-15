import { Prisma } from '@prisma/client';
import { EstimatesService } from './estimates.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';

function fixture() {
  const estimate: any = {
    id: 2,
    idUser: 7,
    number: '190001',
    status: { name: 'Active' },
    order: null,
    payments: [],
    pieces: [],
    taxRate: new Prisma.Decimal('.07'),
    customerTaxRate: new Prisma.Decimal('.07'),
    customerFirstName: null,
  };
  const job: any = {
    status: 'MATERIAL_PAYMENT_PENDING',
    dealerMeasurementsAcceptedAt: new Date(),
    estimate,
    payments: [],
    quotes: [{ status: 'APPROVED', approvalReason: 'DEALER_MEASUREMENTS' }],
  };
  const actor: any = { id: 7, role: { name: 'dealer' } };
  const tx: any = {
    $queryRaw: jest.fn(),
    estimateAgreement: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn(async () => actor) },
    installationJob: { findUnique: jest.fn(async () => job) },
    estimate: {
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (work) => work(tx)),
  };
  const workflow = new InstallationWorkflowService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const service = new EstimatesService(
    prisma,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    workflow,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(service as any, 'getEstimateWithRelationsInTransaction')
    .mockImplementation(async () => ({ ...estimate }));
  jest
    .spyOn(service as any, 'updateEstimateTotalsFromPersistedPieces')
    .mockResolvedValue(undefined);
  return { estimate, job, actor, tx, service };
}

describe('Completing customer details after skipping the installation deposit', () => {
  it('allows filling customer details without reopening the installation quote', async () => {
    const f = fixture();
    const saved = await f.service.updateEstimateHeader(
      2,
      {
        customerFirstName: 'Jane',
        customerLastName: 'Rivera',
        customerTaxRate: 0.07,
      },
      7,
    );
    expect(saved.customerFirstName).toBe('Jane');
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
    expect(f.tx.estimate.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: {
        customerFirstName: 'Jane',
        customerLastName: 'Rivera',
      },
    });
  });

  it('allows tax changes while the waived estimate is still unpaid', async () => {
    const f = fixture();
    await expect(
      f.service.updateEstimateHeader(
        2,
        { customerFirstName: 'Jane', customerTaxRate: 0.08 },
        7,
      ),
    ).resolves.toEqual(expect.objectContaining({ customerFirstName: 'Jane' }));
    expect(f.job.status).toBe('MATERIAL_PAYMENT_PENDING');
  });

  it('keeps another dealer from editing the customer details', async () => {
    const f = fixture();
    f.actor.id = 9;
    await expect(
      f.service.updateEstimateHeader(2, { customerFirstName: 'Jane' }, 9),
    ).rejects.toThrow('not found/denied');
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'PERMIT', status: 'PENDING', stripeSessionId: 'cs_permit' },
    { type: 'MATERIAL', status: 'PAID', paidAt: new Date() },
  ])(
    'blocks customer edits once the project has started payment: %j',
    async (payment) => {
      const f = fixture();
      f.estimate.payments.push(payment);
      await expect(
        f.service.updateEstimateHeader(2, { customerFirstName: 'Jane' }, 7),
      ).rejects.toThrow(/locked|payment process/);
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );

  it('does not relax the edit rule for jobs that paid the normal deposit', async () => {
    const f = fixture();
    f.job.dealerMeasurementsAcceptedAt = null;
    f.job.status = 'MEASUREMENT_SCHEDULING';
    await expect(
      f.service.updateEstimateHeader(2, { customerFirstName: 'Jane' }, 7),
    ).rejects.toThrow('locked');
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });
});

import { GlobalParameterKey, PaymentType, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationWorkflowService } from './installation-workflow.service';

const customer = {
  customerFirstName: 'Jane',
  customerLastName: 'Rivera',
  customerEmail: 'jane@example.test',
  customerPhone: '+13055550111',
  customerStreet: '123 Example Street',
  customerCity: 'Miami',
  customerState: 'FL',
  customerPostalCode: '33101',
};

function fixture(role: 'dealer' | 'client' = 'dealer') {
  const estimate: any = {
    id: 1,
    idUser: 7,
    number: '190001',
    status: { name: 'Active' },
    order: null,
    payments: [],
    installationJob: null,
    manualDiscount: null,
    pieces: [{ id: 2, qty: 1 }],
    ...Object.fromEntries(Object.keys(customer).map((key) => [key, null])),
    user: {
      id: 7,
      role: { name: role },
      dealerMode: 'EXTERNAL',
      firstName: 'Account',
      lastName: 'Owner',
      email: 'owner@example.test',
      phone: '+13055550122',
      street: '456 Account Street',
      city: 'Miami',
      state: 'FL',
      postalCode: '33175',
    },
  };
  const job = {
    id: 3,
    estimateId: 1,
    estimate,
    status: 'DEPOSIT_PAYMENT_PENDING',
    depositAmountSnapshot: new Prisma.Decimal(250),
    depositTermsAcceptedAt: null,
    quotes: [{ id: 4, status: 'DRAFT', total: new Prisma.Decimal(1000) }],
    measurements: [],
  };
  const tx: any = {
    $queryRaw: jest.fn(),
    estimate: { findUnique: jest.fn().mockResolvedValue(estimate) },
    estimateAgreement: { findMany: jest.fn().mockResolvedValue([]) },
    globalParameter: {
      findUnique: jest.fn(async ({ where }) => ({
        value: new Prisma.Decimal(
          where.key === GlobalParameterKey.INSTALLATION_DEPOSIT ? 250 : 0,
        ),
      })),
    },
    installationJob: {
      create: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue(job),
    },
    installationQuoteLine: { count: jest.fn().mockResolvedValue(1) },
  };
  const prisma = {
    $transaction: jest.fn(async (work) => work(tx)),
  };
  const pricing = {
    resolveProfileForUser: jest.fn().mockResolvedValue({
      id: 1,
      name: 'Standard',
      adjustmentPercent: new Decimal(0),
      minimumCharge: new Decimal(0),
    }),
  };
  const workflow = new InstallationWorkflowService(
    prisma as never,
    pricing as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // Se aísla el cálculo de piezas; la solicitud y la validación del pago son reales.
  jest.spyOn(workflow as any, 'measurementCreateFromPiece').mockReturnValue({});
  jest.spyOn(workflow as any, 'rebuildAutomaticLines').mockResolvedValue(null);
  jest
    .spyOn(workflow as any, 'recalculateQuoteTotals')
    .mockResolvedValue(job.quotes[0]);
  jest.spyOn(workflow, 'findJob').mockResolvedValue(job as never);
  jest
    .spyOn(workflow as any, 'notifyInstallationAdmins')
    .mockResolvedValue(null);
  jest
    .spyOn(workflow as any, 'notifyInstallationOwner')
    .mockResolvedValue(null);
  const actor = { id: 7, role: { name: role } };
  const deposit = (preview = false, accepted = true) => {
    estimate.installationJob = job;
    return workflow.getPaymentContext(
      1,
      PaymentType.INSTALLATION_DEPOSIT,
      undefined,
      accepted,
      actor,
      tx,
      { preview },
    );
  };
  return { estimate, job, tx, workflow, actor, deposit };
}

describe('Customer details at installation commitment', () => {
  it.each(['INTERNAL', 'EXTERNAL'])(
    'lets an %s dealer request installation pricing without customer details',
    async (mode) => {
      const f = fixture();
      f.estimate.user.dealerMode = mode;
      const result = await f.workflow.requestInstallation(
        1,
        { permitRequested: false, selectedServices: [] },
        f.actor,
      );
      expect(result.id).toBe(3);
      expect(f.tx.installationJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DEPOSIT_PAYMENT_PENDING' }),
        }),
      );
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it('lets a client request pricing before completing the profile address', async () => {
    const f = fixture('client');
    f.estimate.user.street = null;
    await expect(
      f.workflow.requestInstallation(
        1,
        { permitRequested: false, selectedServices: [] },
        f.actor,
      ),
    ).resolves.toHaveProperty('id', 3);
  });

  it('shows the deposit amount with no customer details and without recording acceptance', async () => {
    const f = fixture();
    const preview = await f.deposit(true, false);
    expect(preview.baseAmount.toFixed(2)).toBe('250.00');
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    await expect(f.deposit()).rejects.toThrow(
      'Complete the customer details in the estimate before paying the installation deposit.',
    );
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
  });

  it.each(Object.keys(customer))(
    'blocks the deposit when %s is blank even if the dealer profile is complete',
    async (key) => {
      const f = fixture();
      Object.assign(f.estimate, customer, { [key]: '   ' });
      await expect(f.deposit()).rejects.toThrow('Missing:');
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it.each(['INTERNAL', 'EXTERNAL'])(
    'allows the %s dealer deposit after the estimate customer is complete',
    async (mode) => {
      const f = fixture();
      f.estimate.user.dealerMode = mode;
      f.estimate.user.street = null;
      Object.assign(f.estimate, customer);
      await expect(f.deposit(false, false)).rejects.toThrow(
        'Accept the non-refundable',
      );
      expect(f.tx.installationJob.update).not.toHaveBeenCalled();
      const context = await f.deposit();
      expect(context.totalAmount.toFixed(2)).toBe('250.00');
      expect(f.tx.installationJob.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { depositTermsAcceptedAt: expect.any(Date) },
      });
    },
  );

  it('requires the direct client profile address and does not use estimate customer fields', async () => {
    const f = fixture('client');
    Object.assign(f.estimate, customer);
    f.estimate.user.street = null;
    await expect(f.deposit()).rejects.toThrow(
      'Complete your profile details before paying the installation deposit. Missing: Street address.',
    );
    expect(f.tx.installationJob.update).not.toHaveBeenCalled();
    f.estimate.user.street = '456 Account Street';
    for (const key of Object.keys(customer)) f.estimate[key] = null;
    expect((await f.deposit()).baseAmount.toFixed(2)).toBe('250.00');
  });
});

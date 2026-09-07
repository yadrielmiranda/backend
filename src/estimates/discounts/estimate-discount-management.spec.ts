import { Prisma } from '@prisma/client';
import { EstimatesService } from '../estimates.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { validate } from 'class-validator';
import { UpdateEstimateDiscountDto } from '../dto/estimate-discount.dto';

const admin = { id: 99, role: { name: 'admin' as const } };
function fixture() {
  const estimate: any = {
    id: 1,
    idUser: 7,
    number: '190001',
    status: { name: 'Active' },
    order: null,
    payments: [],
    pieces: [],
    manualDiscount: null,
    priceT: '1000',
    totalPayable: '1070',
    taxRate: '.07',
  };
  const tx: any = {
    $queryRaw: jest.fn(),
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 99, role: { name: 'admin' } }),
    },
    estimate: {
      findUnique: jest.fn().mockResolvedValue(estimate),
      update: jest.fn(),
    },
    installationJob: { findUnique: jest.fn().mockResolvedValue(null) },
    eventLog: { create: jest.fn() },
  };
  const prisma: any = { $transaction: jest.fn((callback) => callback(tx)) };
  const workflow = { assertEstimateEditAllowed: jest.fn() };
  const service = new EstimatesService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    workflow as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(service, 'findOneForUser').mockResolvedValue(estimate);
  const save = (value = 10, type = 'PERCENTAGE', scope = 'MATERIAL') =>
    service.updateManualDiscount(1, { scope, type, value } as any, admin);
  return { estimate, prisma, tx, service, save };
}

describe('Additional discount administration', () => {
  it('saves only the admin discount and its audit entry without repricing pieces', async () => {
    const f = fixture();
    await f.save();
    expect(f.tx.estimate.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        manualDiscount: expect.objectContaining({
          scope: 'MATERIAL',
          type: 'PERCENTAGE',
          value: '10',
          materialDiscountBasis: 'BEFORE_TAX',
          updatedById: 99,
        }),
      },
    });
    expect(f.tx.eventLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityId: 1, userId: 99 }),
      }),
    );
  });
  it.each(['client', 'dealer', 'operator'])(
    'rejects %s changes on the server',
    async (role) => {
      const f = fixture();
      await expect(
        f.service.updateManualDiscount(
          1,
          { value: 10, scope: 'MATERIAL', type: 'PERCENTAGE' },
          { id: 7, role: { name: role } } as any,
        ),
      ).rejects.toThrow('Only administrators');
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['PENDING', 'PAID', 'REFUNDED'])(
    'preserves terms with an installation payment in status %s',
    async (status) => {
      const f = fixture();
      f.estimate.payments = [
        { type: 'INSTALLATION_DEPOSIT', status, stripeSessionId: null },
      ];
      await expect(f.save()).rejects.toThrow('cannot change after payment');
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );
  it('allows changing and removing a discount after unpaid checkout was canceled', async () => {
    const f = fixture();
    f.estimate.payments = [
      { type: 'MATERIAL', status: 'CANCELED', stripeSessionId: null },
    ];
    await f.save();
    await f.save(0);
    expect(f.tx.estimate.update).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: { manualDiscount: Prisma.DbNull },
    });
  });
  it('rejects a fixed amount exceeding the selected total and installation without a quote', async () => {
    const f = fixture();
    await expect(f.save(1000.01, 'AMOUNT')).rejects.toThrow('cannot exceed');
    await expect(f.save(10, 'PERCENTAGE', 'INSTALLATION')).rejects.toThrow(
      'Include installation',
    );
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });
  it('rejects project discounts in both DTO validation and the service', async () => {
    const dto = Object.assign(new UpdateEstimateDiscountDto(), {
      scope: 'PROJECT',
      type: 'AMOUNT',
      value: 20,
    });
    expect(
      (await validate(dto)).some((error) => error.property === 'scope'),
    ).toBe(true);
    const f = fixture();
    await expect(f.save(20, 'AMOUNT', 'PROJECT')).rejects.toThrow(
      'only to material or installation',
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { status: 'CANCELED', quotes: [{ status: 'DRAFT', total: '200' }] },
    { status: 'DEPOSIT_PAYMENT_PENDING', quotes: [] },
    {
      status: 'DEPOSIT_PAYMENT_PENDING',
      quotes: [{ status: 'REJECTED', total: '200' }],
    },
    {
      status: 'DEPOSIT_PAYMENT_PENDING',
      quotes: [{ status: 'DRAFT', total: '0' }],
    },
  ])(
    'rejects installation without an active positive total: %j',
    async (job) => {
      const f = fixture();
      f.tx.installationJob.findUnique.mockResolvedValue(job);
      await expect(f.save(10, 'PERCENTAGE', 'INSTALLATION')).rejects.toThrow(
        'Include installation',
      );
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );
  it.each(['DRAFT', 'APPROVED'])(
    'allows installation with a calculated %s quote',
    async (status) => {
      const f = fixture();
      f.tx.installationJob.findUnique.mockResolvedValue({
        status: 'DEPOSIT_PAYMENT_PENDING',
        quotes: [{ status, total: '200' }],
      });
      await f.save(20, 'AMOUNT', 'INSTALLATION');
      expect(f.tx.estimate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            manualDiscount: expect.objectContaining({
              scope: 'INSTALLATION',
              value: '20',
            }),
          },
        }),
      );
      await expect(f.save(201, 'AMOUNT', 'INSTALLATION')).rejects.toThrow(
        'cannot exceed',
      );
    },
  );
  it('requires an explicit destination to replace an old project discount and allows removal without a scope', async () => {
    const f = fixture();
    f.estimate.manualDiscount = {
      scope: 'PROJECT',
      type: 'AMOUNT',
      value: '20',
    };
    await expect(
      f.service.updateManualDiscount(1, { value: 20, type: 'AMOUNT' }, admin),
    ).rejects.toThrow('valid discount scope');
    await f.save(20, 'AMOUNT', 'MATERIAL');
    expect(f.tx.estimate.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          manualDiscount: expect.objectContaining({
            scope: 'MATERIAL',
            value: '20',
          }),
        },
      }),
    );
    await f.service.updateManualDiscount(1, { value: 0 }, admin);
    expect(f.tx.estimate.update).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: { manualDiscount: Prisma.DbNull },
    });
  });
  it('rejects locked terms and estimates already converted to orders', async () => {
    const f = fixture();
    f.estimate.order = { id: 5 };
    await expect(f.save()).rejects.toThrow('already has an order');
    f.estimate.order = null;
    f.estimate.manualDiscount = {
      scope: 'PROJECT',
      type: 'PERCENTAGE',
      value: '10',
      lockedAt: '2026-09-07T12:00:00Z',
    };
    await expect(f.save()).rejects.toThrow('paid additional discount');
  });
});

describe('Removing installation and its additional discount', () => {
  function cancellationFixture(scope = 'INSTALLATION', lockedAt?: string) {
    const job: any = {
      id: 2,
      estimateId: 1,
      status: 'DEPOSIT_PAYMENT_PENDING',
      payments: [],
      estimate: { id: 1, idUser: 7, number: '190001' },
    };
    const config = { scope, type: 'AMOUNT', value: '20', lockedAt };
    const tx: any = {
      $queryRaw: jest.fn(),
      installationJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        delete: jest.fn(),
      },
      estimate: {
        findUnique: jest.fn().mockResolvedValue({ manualDiscount: config }),
        update: jest.fn(),
      },
      eventLog: { create: jest.fn() },
    };
    const prisma: any = { $transaction: jest.fn((callback) => callback(tx)) };
    const service: any = new InstallationWorkflowService(
      prisma,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    service.findJob = jest.fn().mockResolvedValue(job);
    service.notifyInstallationAdmins = jest.fn();
    return { job, tx, cancel: () => service.cancelInstallation(2, {}, admin) };
  }
  it('removes an unpaid installation discount atomically with the installation', async () => {
    const f = cancellationFixture();
    await expect(f.cancel()).resolves.toBeNull();
    expect(f.tx.installationJob.delete).toHaveBeenCalledWith({
      where: { id: 2 },
    });
    expect(f.tx.estimate.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { manualDiscount: Prisma.DbNull },
    });
    expect(f.tx.eventLog.create).toHaveBeenCalled();
  });
  it.each(['MATERIAL', 'PROJECT'])(
    'preserves the existing %s discount when installation is removed',
    async (scope) => {
      const f = cancellationFixture(scope);
      await f.cancel();
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );
  it('preserves a locked discount as payment history', async () => {
    const f = cancellationFixture('INSTALLATION', '2026-09-07T12:00:00Z');
    await f.cancel();
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });
  it.each(['PAID', 'REFUNDED', 'PENDING'])(
    'rechecks a concurrent %s payment before removing terms',
    async (status) => {
      const f = cancellationFixture();
      f.tx.installationJob.findUnique.mockResolvedValue({
        ...f.job,
        payments: [
          { type: 'INSTALLATION_DEPOSIT', status, stripeSessionId: 'checkout' },
        ],
      });
      await expect(f.cancel()).rejects.toThrow('payments changed');
      expect(f.tx.installationJob.delete).not.toHaveBeenCalled();
      expect(f.tx.estimate.update).not.toHaveBeenCalled();
    },
  );
});

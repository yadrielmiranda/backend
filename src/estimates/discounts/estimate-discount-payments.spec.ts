import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { PaymentsService } from '@/payments/payments.service';
import { PaymentType, Prisma } from '@prisma/client';
import {
  calculateEstimateDiscount,
  discountAllocations,
} from './estimate-discount';

function fixture() {
  const estimate: any = {
    id: 1,
    idUser: 7,
    number: '190001',
    units: 2,
    status: { name: 'Active' },
    order: null,
    priceT: '1000',
    totalPayable: '1070',
    taxRate: '.07',
    dealerModeSnapshot: 'EXTERNAL',
    manualDiscount: { scope: 'PROJECT', type: 'PERCENTAGE', value: '10' },
    installationJob: {
      id: 2,
      status: 'MATERIAL_PAYMENT_PENDING',
      depositTermsAcceptedAt: new Date(),
      depositAmountSnapshot: '50',
      quotes: [{ status: 'APPROVED', total: '200', version: 1 }],
      permit: { status: 'APPROVED', permitFeeSnapshot: '100', cityFee: '30' },
    },
  };
  const tx: any = {
    $queryRaw: jest.fn(),
    estimate: {
      findUnique: jest.fn().mockResolvedValue(estimate),
      update: jest.fn(),
    },
    globalParameter: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ value: new Prisma.Decimal('.03') }),
    },
    payment: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { baseAmount: new Prisma.Decimal(50) } }),
    },
  };
  const workflow = new InstallationWorkflowService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const context = (type: PaymentType, preview = false) =>
    workflow.getPaymentContext(
      1,
      type,
      1,
      true,
      { id: 7, role: { name: 'client' } },
      tx,
      { preview },
    );
  return { estimate, tx, workflow, context };
}
describe('Manual discount payment integration', () => {
  it('charges the reported $85.95 after a $20 material discount, then adds processing', async () => {
    const f = fixture();
    Object.assign(f.estimate, {
      priceT: '100.33',
      totalPayable: '107.35',
      installationJob: null,
      payments: [],
      manualDiscount: { scope: 'MATERIAL', type: 'AMOUNT', value: '20' },
    });
    const preview = await f.context(PaymentType.MATERIAL, true);
    expect(preview.baseAmount.toFixed(2)).toBe('85.95');
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
    const checkout = await f.context(PaymentType.MATERIAL);
    expect(checkout.baseAmount.toFixed(2)).toBe('85.95');
    expect(checkout.surchargeAmount.toFixed(2)).toBe('2.58');
    expect(f.estimate.manualDiscount).toMatchObject({
      materialDiscountBasis: 'BEFORE_TAX',
      checkoutMaterialNetDiscount: '20.00',
      checkoutAllocations: { material: '21.40' },
    });
  });
  it('freezes the commercial discount after payment and calculates tax on the remaining subtotal', async () => {
    const f = fixture();
    f.estimate.manualDiscount = {
      scope: 'MATERIAL',
      type: 'PERCENTAGE',
      value: '10',
    };
    await f.context(PaymentType.MATERIAL);
    const service: any = new PaymentsService(
      {} as any,
      { get: () => 'sk_test_no_network' } as any,
      { markPaymentPaid: jest.fn().mockResolvedValue(false) } as any,
      {} as any,
    );
    service.notifyPaymentConfirmed = jest.fn();
    await service.ensurePaidPaymentEffects(f.tx, {
      type: PaymentType.INSTALLATION_DEPOSIT,
      idEst: 1,
      paidAt: new Date('2026-09-07T12:00:00Z'),
      estimate: f.estimate,
    });
    expect(f.estimate.manualDiscount.materialNetDiscount).toBe('100.00');
    Object.assign(f.estimate, {
      priceT: '2000',
      taxRate: '.06',
      totalPayable: '2120',
    });
    expect(calculateEstimateDiscount(f.estimate)).toMatchObject({
      discount: '100.00',
      material: { subtotal: '1900.00', tax: '114.00', total: '2014.00' },
    });
  });
  it.each([
    ['MATERIAL', 'PERCENTAGE', '10', '993.00', '150.00', '29.79'],
    ['MATERIAL', 'AMOUNT', '20', '1078.60', '150.00', '32.36'],
    ['INSTALLATION', 'PERCENTAGE', '10', '1100.00', '130.00', '33.00'],
    ['INSTALLATION', 'AMOUNT', '25', '1100.00', '125.00', '33.00'],
  ])(
    'keeps separate payment amounts for %s %s',
    async (scope, type, value, material, installationBalance, surcharge) => {
      const f = fixture();
      f.estimate.manualDiscount = { scope, type, value };
      const materialPayment = await f.context(PaymentType.MATERIAL);
      expect(materialPayment.baseAmount.toFixed(2)).toBe(material);
      expect(materialPayment.surchargeAmount.toFixed(2)).toBe(surcharge);
      f.estimate.installationJob.status = 'PERMIT_PAYMENT_PENDING';
      f.estimate.installationJob.permit.status = 'PAYMENT_PENDING';
      expect((await f.context(PaymentType.PERMIT)).baseAmount.toFixed(2)).toBe(
        '100.00',
      );
      f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
      f.estimate.order = { status: { name: 'Ready to pick up' } };
      expect(
        (await f.context(PaymentType.INSTALLATION)).baseAmount.toFixed(2),
      ).toBe(installationBalance);
    },
  );
  it('charges net material plus net City Fee and adds processing only once', async () => {
    const f = fixture();
    const result = await f.context(PaymentType.MATERIAL);
    expect(result.baseAmount.toFixed(2)).toBe('990.00');
    expect(result.surchargeAmount.toFixed(2)).toBe('29.70');
    expect(result.totalAmount.toFixed(2)).toBe('1019.70');
    expect(f.tx.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          manualDiscount: expect.objectContaining({
            checkoutAllocations: {
              material: '107.00',
              installation: '20.00',
              permit: '10.00',
              city: '3.00',
            },
          }),
        },
      }),
    );
  });
  it('previews the same amount without writing checkout terms', async () => {
    const f = fixture();
    const result = await f.context(PaymentType.MATERIAL, true);
    expect(result.baseAmount.toFixed(2)).toBe('990.00');
    expect(f.tx.estimate.update).not.toHaveBeenCalled();
  });
  it('charges the net permit fee', async () => {
    const f = fixture();
    f.estimate.installationJob.status = 'PERMIT_PAYMENT_PENDING';
    f.estimate.installationJob.permit.status = 'PAYMENT_PENDING';
    expect((await f.context(PaymentType.PERMIT)).baseAmount.toFixed(2)).toBe(
      '90.00',
    );
  });
  it('subtracts the paid deposit from net installation exactly once', async () => {
    const f = fixture();
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    expect(
      (await f.context(PaymentType.INSTALLATION)).baseAmount.toFixed(2),
    ).toBe('130.00');
  });
  it('caps the initial deposit at net installation and supports a free deposit', async () => {
    const f = fixture();
    f.estimate.installationJob.status = 'DEPOSIT_PAYMENT_PENDING';
    f.estimate.installationJob.quotes[0].status = 'DRAFT';
    f.estimate.manualDiscount = {
      scope: 'INSTALLATION',
      type: 'PERCENTAGE',
      value: '90',
    };
    expect(
      (await f.context(PaymentType.INSTALLATION_DEPOSIT)).baseAmount.toFixed(2),
    ).toBe('20.00');
    f.estimate.manualDiscount.value = '100';
    expect(
      (await f.context(PaymentType.INSTALLATION_DEPOSIT)).baseAmount.toFixed(2),
    ).toBe('0.00');
  });
  it('preserves allocations after a paid deposit and leaves canceled unpaid terms editable', async () => {
    const f = fixture();
    await f.context(PaymentType.MATERIAL);
    expect(f.estimate.manualDiscount.lockedAt).toBeUndefined();
    const service: any = new PaymentsService(
      {} as any,
      { get: () => 'sk_test_no_network' } as any,
      { markPaymentPaid: jest.fn().mockResolvedValue(false) } as any,
      {} as any,
    );
    service.notifyPaymentConfirmed = jest.fn();
    const payment = {
      type: PaymentType.INSTALLATION_DEPOSIT,
      idEst: 1,
      paidAt: new Date('2026-09-07T12:00:00Z'),
      estimate: f.estimate,
    };
    await service.ensurePaidPaymentEffects(f.tx, payment);
    expect(f.estimate.manualDiscount.lockedAt).toBe(
      payment.paidAt.toISOString(),
    );
    expect(f.estimate.manualDiscount.allocations).toEqual(
      f.estimate.manualDiscount.checkoutAllocations,
    );
  });
  it('recognizes a fully discounted installation as paid when material is ready', async () => {
    const f = fixture();
    f.estimate.manualDiscount.value = '100';
    const summary = calculateEstimateDiscount(f.estimate)!;
    f.estimate.manualDiscount = {
      ...f.estimate.manualDiscount,
      lockedAt: new Date().toISOString(),
      allocations: discountAllocations(summary),
    };
    const job = {
      ...f.estimate.installationJob,
      estimate: f.estimate,
      status: 'MATERIAL_PAID',
      payments: [],
    };
    f.tx.installationJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn(),
    };
    await f.workflow.markOrderReady(f.tx, 1);
    expect(f.tx.installationJob.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { status: 'INSTALLATION_PAID' },
    });
  });
});

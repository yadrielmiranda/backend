import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { buildPaymentSchedule, scheduleAmounts } from '@/payment-plans/payment-schedule';
import { defaultPlan } from '@/payment-plans/payment-plan';
import { discountedInstallationTotal } from './discounts/estimate-discount';
import { PaymentType, Prisma } from '@prisma/client';

function fixture() {
  const charge = (source: string, pricingMode: string, pricingValue: string, sourceRefId: number | null = null) => ({
    id: sourceRefId ?? 1, origin: source === 'CUSTOM' ? 'DEALER' : 'SYSTEM', source,
    sourceKey: source === 'INSTALLATION_SERVICE' ? `SERVICE:${sourceRefId}` : source,
    sourceRefId, description: source, pricingMode, pricingValue, usedInCustomerQuote: true,
    systemAmountSnapshot: null, sortOrder: 1,
  });
  const estimate: any = {
    id: 1, idUser: 7, number: '190001', units: 2,
    status: { name: 'Active' }, order: null, payments: [],
    priceT: '800', totalPayable: '856', taxRate: '.07',
    customerPriceT: '1000', customerTotalPayable: '1070', customerTaxRate: '.07',
    user: { role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    dealerModeSnapshot: 'INTERNAL', manualDiscount: null,
    customerCharges: [
      charge('INSTALLATION', 'PERCENTAGE', '25'),
      charge('INSTALLATION_SERVICE', 'AMOUNT', '50', 2),
      charge('PERMIT', 'PERCENTAGE', '10'),
      charge('CITY_FEE', 'AMOUNT', '5'),
      charge('CUSTOM', 'FINAL', '75'),
    ],
    installationJob: {
      id: 2, status: 'MATERIAL_PAYMENT_PENDING', depositAmountSnapshot: '50',
      depositTermsAcceptedAt: new Date(),
      quotes: [{ status: 'APPROVED', total: '1000', version: 1, lines: [
        { serviceId: 1, origin: 'AUTO', serviceNameSnapshot: 'Install', adjustedAmount: '800' },
        { serviceId: 2, origin: 'USER_SELECTED', serviceNameSnapshot: 'Removal', adjustedAmount: '200' },
      ] }],
      permit: { status: 'APPROVED', permitFeeSnapshot: '100', cityFee: '40' },
    },
  };
  const tx: any = {
    $queryRaw: jest.fn(),
    estimate: { findUnique: jest.fn().mockResolvedValue(estimate), update: jest.fn() },
    globalParameter: { findUnique: jest.fn().mockResolvedValue({ value: new Prisma.Decimal('.03') }) },
  };
  const workflow = new InstallationWorkflowService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const context = (type: PaymentType) => workflow.getPaymentContext(1, type, 1, true,
    { id: 7, role: { name: 'dealer' } }, tx, { preview: true });
  return { estimate, context };
}

describe('Internal dealer customer charges collected by the company', () => {
  it('includes every markup and custom charge exactly once in the payment schedule', () => {
    const { estimate } = fixture();
    estimate.paymentPlanSnapshot = { version: 1, planId: null, name: 'Default', definition: defaultPlan };
    expect(scheduleAmounts(estimate)).toEqual({ material: '1070.00', installation: '1325.00', permit: '110.00', city: '45.00' });
    const schedule = buildPaymentSchedule(estimate)!;
    expect(schedule.rows.map(row => row.amount)).toEqual(['1225.00', '1325.00']);
    expect(schedule.balance).toBe('2550.00');
  });

  it('preserves discounts on the system base and adds internal charges afterward', () => {
    const { estimate } = fixture();
    estimate.manualDiscount = { scope: 'MULTIPLE', material: { type: 'PERCENTAGE', value: '10' },
      installation: { type: 'PERCENTAGE', value: '10' }, materialDiscountBasis: 'BEFORE_TAX' };
    expect(scheduleAmounts(estimate)).toEqual({ material: '963.00', installation: '1225.00', permit: '110.00', city: '45.00' });
    expect(discountedInstallationTotal(estimate, estimate.installationJob).toFixed(2)).toBe('1225.00');
  });

  it.each([null, { status: 'CANCELED' }])('collects independent custom charges when installation is absent or removed (%j)', (job) => {
    const { estimate } = fixture();
    estimate.installationJob = job;
    expect(scheduleAmounts(estimate)).toEqual({ material: '1145.00', installation: '0.00', permit: '0.00', city: '0.00' });
  });

  it('keeps external dealer resale charges out of company payments', () => {
    const { estimate } = fixture();
    estimate.user.dealerMode = estimate.dealerModeSnapshot = 'EXTERNAL';
    expect(scheduleAmounts(estimate)).toEqual({ material: '856.00', installation: '1000.00', permit: '100.00', city: '40.00' });
  });

  it('collects the same additions for an internal subdealer customer', () => {
    const { estimate } = fixture();
    estimate.networkBillingPriceT = '1000';
    estimate.dealerNetworkSnapshot = {
      version: 1, rootMode: 'INTERNAL', billingIndex: 2, billingAccountId: 7, payerType: 'CUSTOMER',
      billingTaxRate: '.07', nodes: [{ id: 6, mode: 'INTERNAL' }, { id: 7, mode: 'INTERNAL' }],
    };
    expect(scheduleAmounts(estimate)).toEqual({ material: '1070.00', installation: '1325.00', permit: '110.00', city: '45.00' });
  });

  it('includes internal additions in legacy material, permit and installation checkout', async () => {
    const f = fixture();
    const material = await f.context(PaymentType.MATERIAL);
    expect(material.baseAmount.toFixed(2)).toBe('1115.00');
    expect(material.processingComponents?.city).toBe('45.00');
    f.estimate.installationJob.status = 'PERMIT_PAYMENT_PENDING';
    f.estimate.installationJob.permit.status = 'PAYMENT_PENDING';
    expect((await f.context(PaymentType.PERMIT)).baseAmount.toFixed(2)).toBe('110.00');
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    f.estimate.payments = [{ installationJobId: 2, type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '50' }];
    const installation = await f.context(PaymentType.INSTALLATION);
    expect(installation.baseAmount.toFixed(2)).toBe('1275.00');
    expect(installation.surchargeAmount.toFixed(2)).toBe('38.25');
  });

  it('collects custom charges without requiring an installation in legacy checkout', async () => {
    const f = fixture();
    f.estimate.installationJob = null;
    const payment = await f.context(PaymentType.MATERIAL);
    expect(payment.baseAmount.toFixed(2)).toBe('1145.00');
    expect(payment.processingComponents).toMatchObject({ material: '1070.00', other: '75.00' });
  });

  it('freezes provider, profile margin and dealer additions independently at checkout', async () => {
    const f = fixture();
    f.estimate.installationJob.quotes[0].providerCostSnapshot = { schema: 1, total: '800.00' };
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    const payment = await f.context(PaymentType.INSTALLATION);
    expect(payment.baseAmount.toFixed(2)).toBe('1325.00');
    expect(payment.processingComponents?.installationShare).toEqual({
      provider: '800.00', company: '200.00', dealer: '325.00',
    });
  });

  it('takes an installation discount from the profile margin while preserving provider tariffs', async () => {
    const f = fixture();
    f.estimate.installationJob.quotes[0].providerCostSnapshot = { schema: 1, total: '800.00' };
    f.estimate.manualDiscount = { scope: 'INSTALLATION', type: 'PERCENTAGE', value: '10' };
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    const payment = await f.context(PaymentType.INSTALLATION);
    expect(payment.baseAmount.toFixed(2)).toBe('1225.00');
    expect(payment.processingComponents?.installationShare).toEqual({
      provider: '800.00', company: '100.00', dealer: '325.00',
    });
  });

  it('allocates a scheduled deposit to the first installment instead of counting installation twice', async () => {
    const f = fixture();
    f.estimate.paymentPlanSnapshot = { version: 1, planId: null, name: 'Default', definition: defaultPlan };
    f.estimate.installationJob.status = 'DEPOSIT_PAYMENT_PENDING';
    f.estimate.installationJob.quotes[0].status = 'DRAFT';
    f.estimate.installationJob.quotes[0].providerCostSnapshot = { schema: 1, total: '800.00' };
    const payment = await f.context(PaymentType.INSTALLATION_DEPOSIT);
    expect(payment.baseAmount.toFixed(2)).toBe('50.00');
    expect(payment.processingComponents?.installation).toBe('0.00');
    expect(payment.processingComponents?.installationShare).toBeUndefined();
    // The first installment also includes permit/city amounts, so the deposit
    // follows that composition rather than all belonging to installation.
    expect(Number(payment.processingComponents?.material)).toBeGreaterThan(0);
  });

  it('allocates a revised quote when prior card collections were exclusively material', async () => {
    const f = fixture();
    Object.assign(f.estimate.installationJob.quotes[0], { version: 2, providerCostSnapshot: { schema: 1, total: '800.00' } });
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    f.estimate.payments = [{ type: 'MATERIAL', status: 'PAID', baseAmount: '100', processingCostSnapshot: {
      version: 1, components: { material: '100.00', installation: '0.00', permit: '0.00', city: '0.00', other: '0.00' },
    } }];
    expect((await f.context(PaymentType.INSTALLATION)).processingComponents?.installationShare)
      .toEqual({ provider: '800.00', company: '200.00', dealer: '325.00' });
  });

  it('does not invent a revised supplier allocation when prior installation collections have no trustworthy split', async () => {
    const f = fixture();
    Object.assign(f.estimate.installationJob.quotes[0], { version: 2, providerCostSnapshot: { schema: 1, total: '800.00' } });
    f.estimate.installationJob.status = 'INSTALLATION_PAYMENT_PENDING';
    f.estimate.order = { status: { name: 'Ready to pick up' } };
    f.estimate.payments = [{ installationJobId: 2, type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '50' }];
    const payment = await f.context(PaymentType.INSTALLATION);
    expect(payment.processingComponents?.installationSharePending).toBe(true);
    expect(payment.processingComponents?.installationShare).toBeUndefined();
  });
});

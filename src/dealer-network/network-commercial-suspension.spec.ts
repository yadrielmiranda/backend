import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentType, Prisma } from '@prisma/client';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { PaymentsService } from '@/payments/payments.service';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { createNetworkSnapshot } from './dealer-network';
import { estimateNewBusinessBlocked, hasExistingBusiness } from './network-access';

// Persistencia y Stripe simulados; los permisos, precios y contextos de pago son reales.
async function fixture(internal = false) {
  const users: any[] = [1, 2, 3].map(id => ({
    id, username: `dealer${id}`, firstName: 'Dealer', lastName: String(id),
    role: { name: 'dealer', markup: '0' }, idRole: 2,
    parentDealerId: id === 1 ? null : id - 1,
    dealerMode: internal && id < 3 ? 'INTERNAL' : 'EXTERNAL',
    isActive: true, networkSuspended: false, deletedAt: null,
    networkMarkup: new Prisma.Decimal('.15'), subdealerEarningsMode: 'MARKUP',
    dealerEarningsPlanId: internal && id === 1 ? 10 : null, isTaxExempt: false,
  }));
  const withParent = (id: number): any => {
    const user = users.find(candidate => candidate.id === id);
    return user && { ...user, parentDealer: user.parentDealerId ? withParent(user.parentDealerId) : null };
  };
  const tx: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => sql.join('').includes('DealerEarningsPlan')
      ? [{ id: 10, name: 'Internal plan', revision: 1, basis: 'DEALER_MARKUP', percent: '50', isActive: true }] : []),
    user: { findUnique: jest.fn(async ({ where }) => withParent(where.id)) },
    globalParameter: { findUnique: jest.fn(async () => ({ value: new Prisma.Decimal(0) })) },
    estimateAgreement: { findFirst: jest.fn(async () => null) },
  };
  const ownerId = internal ? 2 : 3;
  const snapshot = await createNetworkSnapshot(tx, users[ownerId - 1], '0');
  users[1].networkSuspended = true;
  const estimate: any = {
    id: 10, idUser: ownerId, number: '190999', units: 1,
    user: withParent(ownerId), status: { name: 'Active' },
    dealerModeSnapshot: internal ? 'INTERNAL' : 'EXTERNAL',
    dealerNetworkSnapshot: snapshot, networkBillingPriceT: '100.00',
    networkRootPriceT: '100.00', networkSubdealerPriceT: '115.00',
    priceT: '132.25', customerPriceT: '150.00', rateT: '80.00',
    totalPayable: '132.25', customerTotalPayable: '150.00', taxRate: '0', customerTaxRate: '0',
    payments: [], order: null, installationJob: null,
    publicTokenEnabled: true, publicToken: 'customer-payment',
  };
  tx.estimate = { findUnique: jest.fn(async () => estimate), findFirst: jest.fn(async () => estimate) };
  tx.$transaction = jest.fn(async work => work(tx));
  const workflow = Object.create(InstallationWorkflowService.prototype) as InstallationWorkflowService;
  const service = new PaymentsService(tx, { get: () => 'sk_test_local_only' } as any, workflow, {} as any);
  const stripe = { checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } } };
  (service as any).stripe = stripe;
  const payer: any = { id: internal ? 2 : 1, role: { name: 'dealer' } };
  const paymentContext = (type: PaymentType = PaymentType.MATERIAL, preview = false, user = payer) =>
    workflow.getPaymentContext(10, type, type === 'DELIVERY' ? 1 : undefined, undefined, user, tx, { preview });
  return { users, withParent, estimate, tx, workflow, service, payer, stripe, paymentContext };
}

describe('Commercial suspension and existing business', () => {
  it.each([false, true])('blocks a first payment even when the payer is an active ancestor (preview=%s)', async preview => {
    const f = await fixture();
    expect(f.users[0].networkSuspended).toBe(false);
    await expect(f.paymentContext(PaymentType.MATERIAL, preview)).rejects.toThrow(ConflictException);
  });

  it('rejects a new authenticated checkout before contacting Stripe', async () => {
    const f = await fixture();
    await expect(f.service.createCheckoutSessionForEstimate({ estimateId: 10, user: f.payer }))
      .rejects.toThrow('New business is suspended');
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('does not treat an unpaid Stripe session or a signature as payment received', async () => {
    const f = await fixture();
    f.estimate.payments = [{ type: 'MATERIAL', status: 'PENDING', stripeSessionId: 'cs_unpaid' }];
    f.estimate.signedAt = new Date();
    await expect(f.paymentContext()).rejects.toThrow('New business is suspended');
  });

  it('retains ownership checks for existing work', async () => {
    const f = await fixture(); f.estimate.order = { id: 20 };
    await expect(f.paymentContext(PaymentType.MATERIAL, false, { id: 999, role: { name: 'dealer' } }))
      .rejects.toThrow(NotFoundException);
  });

  it('allows the material payment after a paid installation deposit and preserves the agreed network price', async () => {
    const f = await fixture();
    f.estimate.payments = [{ type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '25.00' }];
    f.estimate.installationJob = { id: 5, status: 'MATERIAL_PAYMENT_PENDING', quotes: [{ status: 'APPROVED', total: '500.00' }] };
    const before = JSON.stringify(f.estimate);
    const context = await f.paymentContext();
    expect(context.baseAmount.toFixed(2)).toBe('100.00');
    expect(JSON.stringify(f.estimate)).toBe(before);
  });

  it('keeps an existing delivery payable after suspension', async () => {
    const f = await fixture();
    f.estimate.order = { id: 20, number: 'ORD-20', status: { name: 'Ready to pick up' }, deliveries: [] };
    f.estimate.status.name = 'Ordered';
    f.tx.orderDelivery = { findFirst: jest.fn(async () => ({ sequence: 1, status: 'PAYMENT_DUE', total: '40.00' })) };
    const context = await f.paymentContext(PaymentType.DELIVERY);
    expect(context.baseAmount.toFixed(2)).toBe('40.00');
    expect(context.description).toContain('ORD-20');
  });

  it.each([
    { status: 'PAID', baseAmount: '0' },
    { status: 'PENDING', paidAt: new Date() },
    { status: 'REFUNDED', baseAmount: '25' },
    { status: 'PENDING', netPaidBaseAmount: '10' },
    { status: 'PENDING', refundedAmount: '10' },
    { status: 'PENDING', refundCreditAmount: '10' },
    { status: 'PENDING', refundReviewPending: true },
  ])('retains payment history for an existing commitment: %j', async payment => {
    const f = await fixture(); f.estimate.payments = [payment];
    expect(hasExistingBusiness(f.estimate)).toBe(true);
    await expect(estimateNewBusinessBlocked(f.tx, f.estimate)).resolves.toBe(false);
  });

  it('lets an unpaid estimate proceed after reactivation without reopening a separately suspended child', async () => {
    const f = await fixture();
    f.users[1].networkSuspended = false;
    f.estimate.user = f.withParent(3);
    await expect(f.paymentContext()).resolves.toMatchObject({ paymentSequence: 1 });
    f.users[2].networkSuspended = true;
    f.estimate.user = f.withParent(3);
    await expect(f.paymentContext()).rejects.toThrow('New business is suspended');
  });

  it('exposes inherited suspension but leaves existing payments enabled in the API presentation', async () => {
    const f = await fixture();
    const draft = presentApiResponse(f.estimate, f.payer);
    expect(draft.networkPaymentBlocked).toBe(true);
    expect(draft.user).toMatchObject({ networkSalesBlocked: true, networkAccessBlocked: false });
    f.estimate.order = { id: 20 };
    expect(presentApiResponse(f.estimate, f.payer).networkPaymentBlocked).toBe(false);
  });

  it('marks an unpaid public payment link unavailable and rejects checkout without exposing account details', async () => {
    const f = await fixture(true);
    await expect(f.service.getPublicPaymentContext('customer-payment')).resolves.toEqual({
      enabled: true, status: 'unavailable', payment: null,
    });
    await expect(f.service.createCheckoutSessionForPublicToken({ token: 'customer-payment' }))
      .rejects.toThrow(ConflictException);
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('keeps the public customer payment link payable when the installation deposit was already received', async () => {
    const f = await fixture(true);
    f.estimate.payments = [{ type: 'INSTALLATION_DEPOSIT', sequence: 1, status: 'PAID', baseAmount: '25.00' }];
    f.estimate.installationJob = { id: 5, status: 'MATERIAL_PAYMENT_PENDING', quotes: [{ status: 'APPROVED', total: '500.00' }] };
    const context = await f.service.getPublicPaymentContext('customer-payment');
    expect(context.status).toBe('due');
    expect(context.payment).toMatchObject({ type: 'MATERIAL', baseAmount: '100.00' });
  });
});

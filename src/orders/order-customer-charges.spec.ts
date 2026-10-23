import { OrdersService } from './orders.service';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';

function fixture() {
  const estimate = {
    id: 9, idUser: 7, dealerModeSnapshot: 'INTERNAL', status: { name: 'Ordered' },
    user: { dealerMode: 'INTERNAL', role: { name: 'dealer' } },
    rateT: '600', priceT: '800', customerPriceT: '1000', customerTotalPayable: '1000',
    dealerEarningsPlanSnapshot: { version: 2, planId: 1, name: 'Markup', revision: 1, basis: 'DEALER_MARKUP', percent: '100' },
    payments: [], customerCharges: [
      { id: 1, origin: 'SYSTEM', source: 'INSTALLATION', sourceKey: 'INSTALLATION', sourceRefId: null,
        description: 'Installation', pricingMode: 'PERCENTAGE', pricingValue: '20',
        systemAmountSnapshot: '400', usedInCustomerQuote: true, sortOrder: 10 },
      { id: 2, origin: 'DEALER', source: 'CUSTOM', sourceKey: null, sourceRefId: null,
        description: 'Site preparation', pricingMode: 'FINAL', pricingValue: '100',
        systemAmountSnapshot: null, usedInCustomerQuote: true, sortOrder: 1000 },
    ],
    installationJob: {
      id: 3, status: 'REQUESTED', permit: null,
      quotes: [{ version: 1, status: 'DRAFT', total: '525', serviceMinimumsSnapshot: [],
        lines: [{ serviceId: 1, origin: 'USER_SELECTED', serviceNameSnapshot: 'Concrete cutting', adjustedAmount: '125' }] }],
    },
  };
  const order = { id: 1, idEst: 9, userId: 7, status: { name: 'Pending' }, estimate, deliveries: [], extraCharges: [] };
  const selectedOrder = (query: any) => {
    const selection = query.include.estimate.include.installationJob.include.quotes;
    let quotes = [...estimate.installationJob.quotes].sort((left, right) => right.version - left.version);
    if (selection.where?.status?.not) quotes = quotes.filter(quote => quote.status !== selection.where.status.not);
    if (selection.take) quotes = quotes.slice(0, selection.take);
    return { ...order, estimate: { ...estimate, installationJob: { ...estimate.installationJob, quotes } } };
  };
  const db = {
    order: { findUnique: jest.fn(async (query: any) => selectedOrder(query)),
      findMany: jest.fn(async (query: any) => [selectedOrder(query)]) },
    estimate: { findUnique: jest.fn().mockResolvedValue(estimate) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { db, estimate, service: new OrdersService(db as any, {} as any, {} as any, {} as any) };
}

describe('Order customer installation prices', () => {
  it('returns the same internal customer markup and custom charges in detail and list responses', async () => {
    const { service, db } = fixture();
    const detail = await service.findOne(1);
    const dealerDetail = await service.findOneForUser(1, { id: 7, role: { name: 'dealer' } } as any);
    const [list] = await service.findAll();
    for (const order of [detail, dealerDetail, list]) {
      expect(order.estimate.customerChargesSummary).toMatchObject({
        systemTotal: '525.00', customerTotal: '705.00', dealerCreatedTotal: '100.00',
      });
      expect(order.estimate.customerChargesSummary?.lines[0].customerAmount).toBe('480.00');
      expect(order.estimate).not.toHaveProperty('customerCharges');
    }
    expect(db.order.findUnique.mock.calls[0][0].include.estimate.include).toMatchObject({
      user: { select: { dealerMode: true, role: { select: { name: true } } } }, customerCharges: true,
      installationJob: { include: { quotes: { include: { lines: true } } } },
    });
  });

  it('keeps the valid quote and owner earnings after a newer installation revision is rejected', async () => {
    const { service, estimate } = fixture();
    const valid = estimate.installationJob.quotes[0];
    valid.status = 'APPROVED';
    estimate.installationJob.quotes.unshift({ ...valid, version: 2, status: 'REJECTED', total: '825' });
    const actor = { id: 7, role: { name: 'dealer' } } as const;
    const detail = await service.findOne(1);
    const dealerDetail = await service.findOneForUser(1, actor);
    const [list] = await service.findAll();
    const [dealerList] = await service.findAllForUser(actor);
    for (const order of [detail, dealerDetail, list, dealerList]) {
      const summary = order.estimate.customerChargesSummary!;
      expect(order.estimate.installationSummary).toMatchObject({ quoteStatus: 'APPROVED', installationTotal: '525.00' });
      expect(summary).toMatchObject({ systemTotal: '525.00', customerTotal: '705.00',
        systemTotalIncomplete: false, customerTotalIncomplete: false });
      expect(summary.lines.every(line => !line.needsReview)).toBe(true);
      expect(order.dealerEarnings).toMatchObject({ amount: '200.00', status: 'CALCULATED' });
      const services = Number(summary.customerTotal) - Number(summary.systemTotal);
      expect(services).toBe(180);
      expect(Number(order.dealerEarnings!.amount) + services).toBe(380);
    }
    expect(estimate.installationJob.quotes[0].status).toBe('REJECTED');
  });
});

describe('Current material payment terms in order lists', () => {
  it.each(['UNPAID', 'PAID', 'REFUNDED'])('matches order details without changing %s history', async paymentStatus => {
    const snapshot = {
      version: 1, name: 'Half now', planId: 1,
      definition: {
        withoutInstallation: [
          { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
          { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
        ],
        withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 100 }],
      },
    };
    const estimate = {
      id: 9, idUser: 7, date: new Date('2024-01-01'), units: 1,
      dealerModeSnapshot: 'EXTERNAL', status: { name: 'Ordered' },
      user: { dealerMode: 'EXTERNAL', role: { name: 'dealer' } },
      rateT: '300', priceT: '400', customerPriceT: '400', totalPayable: '400', customerTotalPayable: '400',
      paymentPlanSnapshot: snapshot, customerCharges: [], installationJob: null,
      order: { id: 1, status: { name: 'Awaiting release' } },
      payments: paymentStatus === 'UNPAID' ? [] : [{
        id: 20, type: 'INSTALLMENT', sequence: 1, status: paymentStatus, baseAmount: '200',
        ...(paymentStatus === 'REFUNDED' ? { netPaidBaseAmount: '0', refundedAmount: '200' } : {}),
      }],
    };
    const order = { id: 1, idEst: 9, userId: 7, status: estimate.order.status, estimate, deliveries: [], extraCharges: [] };
    const db = {
      order: { findMany: jest.fn(async () => [order]), findUnique: jest.fn(async () => order) },
      estimate: { findUnique: jest.fn(async () => estimate) },
      user: { findMany: jest.fn(async () => []) },
      globalParameter: { findUnique: jest.fn(async () => ({ value: '500.00' })) },
    };
    const service = new OrdersService(db as any, {} as any, {} as any, {} as any);
    const original = JSON.stringify(order);

    for (const threshold of ['500.00', '250.00']) {
      db.globalParameter.findUnique.mockResolvedValue({ value: threshold });
      const expected = paymentStatus === 'UNPAID' && threshold === '500.00'
        ? ['400.00'] : ['200.00', '200.00'];
      const detail = await service.findOne(1);
      expect(detail.paymentSchedule?.rows.map(row => row.amount)).toEqual(expected);
      for (const actor of [{ id: 1, role: { name: 'admin' } }, { id: 7, role: { name: 'dealer' } }]) {
        const [listed] = await service.findAllForUser(actor as any);
        const schedule = buildPaymentSchedule({ ...listed.estimate, order: listed });
        expect(schedule?.rows.map(row => row.amount)).toEqual(expected);
        expect(listed.paymentAnchor).toBe('estimate-payment');
      }
      expect(JSON.stringify(order)).toBe(original);
    }
    if (paymentStatus !== 'UNPAID') expect(db.globalParameter.findUnique).not.toHaveBeenCalled();
  });
});

import { OrdersService } from './orders.service';

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

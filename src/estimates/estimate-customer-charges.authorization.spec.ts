import { EstimateCustomerChargesService } from './estimate-customer-charges.service';

const dealer = { id: 10, role: { name: 'dealer' } } as const;
const admin = { id: 1, role: { name: 'admin' } } as const;
const rule = { source: 'INSTALLATION', pricingMode: 'AMOUNT', value: 125 } as const;

function fixture(mode: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL') {
  let nextId = 1;
  const estimate: any = {
    id: 20, number: 'Q20', idUser: dealer.id, dealerModeSnapshot: mode,
    dealerNetworkSnapshot: null, status: { name: 'Active' }, order: null,
    user: { dealerMode: mode, role: { name: 'dealer' } }, payments: [], customerCharges: [],
    installationJob: {
      id: 30, status: 'APPROVED', installationAddress: null, permit: null,
      quotes: [{ status: 'APPROVED', total: '1000.00', installationSurcharge: '0', serviceMinimumsSnapshot: [], lines: [] }],
    },
  };
  const db: any = {
    $queryRaw: jest.fn(async () => [{ id: estimate.id, paymentPlanSnapshot: null }]),
    estimate: {
      findUnique: jest.fn(async () => estimate),
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)),
    },
    estimateAgreement: { findMany: jest.fn(async () => []) },
    estimateCustomerCharge: {
      upsert: jest.fn(async ({ where, create, update }) => {
        const existing = estimate.customerCharges.find((charge: any) => charge.sourceKey === where.estimateId_sourceKey.sourceKey);
        if (existing) return Object.assign(existing, update);
        const charge = { id: nextId++, ...create };
        estimate.customerCharges.push(charge);
        return charge;
      }),
      findFirst: jest.fn(async ({ where }) => estimate.customerCharges.find((charge: any) =>
        (where.id === undefined || charge.id === where.id) &&
        (where.origin === undefined || charge.origin === where.origin),
      ) ?? null),
      create: jest.fn(async ({ data }) => {
        const charge = { id: nextId++, usedInCustomerQuote: true, ...data };
        estimate.customerCharges.push(charge);
        return charge;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(estimate.customerCharges.find((charge: any) => charge.id === where.id), data)),
      delete: jest.fn(async ({ where }) => {
        estimate.customerCharges = estimate.customerCharges.filter((charge: any) => charge.id !== where.id);
      }),
    },
  };
  db.$transaction = async (work: (tx: any) => Promise<unknown>) => work(db);
  return { db, estimate, service: new EstimateCustomerChargesService(db) };
}

describe('customer charge editing permissions and internal rules', () => {
  it.each([dealer, admin])('lets $role.name edit internal installation and custom charges', async actor => {
    const f = fixture();
    const first = await f.service.upsertSystemCharge(f.estimate.id, rule, actor);
    expect(first?.customerTotal).toBe('1125.00');
    expect(f.db.$queryRaw).toHaveBeenCalled();
    await f.service.createDealerCharge(f.estimate.id, { description: 'Field repair', amount: 75 }, actor);
    expect(f.estimate.customerCharges).toHaveLength(2);
    const custom = f.estimate.customerCharges.find((charge: any) => charge.origin === 'DEALER');
    expect((await f.service.updateDealerCharge(f.estimate.id, custom.id, { amount: 90 }, actor))?.customerTotal).toBe('1215.00');
    expect((await f.service.removeCharge(f.estimate.id, custom.id, actor))?.customerTotal).toBe('1125.00');
  });

  it('allows resetting an internal markup to the base without removing installation', async () => {
    const f = fixture();
    await f.service.upsertSystemCharge(f.estimate.id, rule, dealer);
    const result = await f.service.removeCharge(f.estimate.id, f.estimate.customerCharges[0].id, dealer);
    expect(result?.customerTotal).toBe('1000.00');
    expect(result?.lines[0]).toMatchObject({ usedInCustomerQuote: true, pricingMode: 'AMOUNT', pricingValue: '0.0000' });
    expect(f.estimate.installationJob.id).toBe(30);
  });

  it.each([
    { ...rule, pricingMode: 'FINAL' },
    { ...rule, pricingMode: 'SAME' },
    { ...rule, usedInCustomerQuote: false },
    { ...rule, value: -1 },
  ])('rejects an internal attempt to replace or exclude company pricing: %j', async invalid => {
    const f = fixture();
    await expect(f.service.upsertSystemCharge(f.estimate.id, invalid as any, admin)).rejects.toThrow('must stay included');
    expect(f.db.estimateCustomerCharge.upsert).not.toHaveBeenCalled();
  });

  it.each(['AMOUNT', 'PERCENTAGE'] as const)('accepts zero %s as the internal company price', async pricingMode => {
    const f = fixture();
    expect((await f.service.upsertSystemCharge(f.estimate.id, { ...rule, pricingMode, value: 0 }, dealer))?.customerTotal).toBe('1000.00');
  });

  it('allows a manual internal charge even when no installation has been requested', async () => {
    const f = fixture(); f.estimate.installationJob = null;
    expect((await f.service.createDealerCharge(f.estimate.id, { description: 'Site cleaning', amount: 125 }, dealer))?.customerTotal).toBe('125.00');
    expect(f.estimate.installationJob).toBeNull();
  });

  it.each([
    { id: 99, role: { name: 'dealer' } },
    { id: dealer.id, role: { name: 'operator' } },
    { id: dealer.id, role: { name: 'client' } },
  ])('rejects an unauthorized actor %j', async actor => {
    const f = fixture();
    await expect(f.service.createDealerCharge(f.estimate.id, { description: 'Fee', amount: 10 }, actor as any)).rejects.toThrow('not found');
    expect(f.db.estimateCustomerCharge.create).not.toHaveBeenCalled();
  });

  it('does not enable dealer charges for an admin-owned estimate', async () => {
    const f = fixture(); f.estimate.idUser = admin.id; f.estimate.user.role.name = 'admin';
    await expect(f.service.upsertSystemCharge(f.estimate.id, rule, admin)).rejects.toThrow('only available on dealer estimates');
  });

  it.each(['PENDING', 'PAID', 'REFUNDED'])('locks internal changes for %s payments', async status => {
    const f = fixture();
    f.estimate.payments = [{ status, paidAt: null, refundReviewPending: false }];
    await expect(f.service.upsertSystemCharge(f.estimate.id, rule, admin)).rejects.toThrow('cannot change after payment');
    await expect(f.service.createDealerCharge(f.estimate.id, { description: 'Fee', amount: 10 }, dealer)).rejects.toThrow('cannot change after payment');
    expect(f.db.estimateCustomerCharge.create).not.toHaveBeenCalled();
  });

  it('uses saved internal subdealer terms despite a changed current account mode', async () => {
    const f = fixture('EXTERNAL');
    f.estimate.dealerNetworkSnapshot = {
      version: 1, nodes: [{ id: 2, mode: 'INTERNAL' }, { id: dealer.id, mode: 'INTERNAL' }],
      billingIndex: 2, billingAccountId: dealer.id,
    };
    await expect(f.service.upsertSystemCharge(f.estimate.id, { ...rule, usedInCustomerQuote: false }, admin)).rejects.toThrow('must stay included');
  });

  it('retains external final prices and exclusions, including admin editing on their behalf', async () => {
    const f = fixture('EXTERNAL');
    f.estimate.payments = [{ status: 'PAID', paidAt: new Date(), refundReviewPending: false }];
    const result = await f.service.upsertSystemCharge(f.estimate.id, { ...rule, pricingMode: 'FINAL', usedInCustomerQuote: false }, admin);
    expect(result).toMatchObject({ systemTotal: '1000.00', customerTotal: '0.00' });
    expect(result?.lines[0]).toMatchObject({ customerAmount: '125.00', usedInCustomerQuote: false });
  });
});

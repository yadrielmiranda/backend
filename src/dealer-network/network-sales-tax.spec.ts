import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { DealerNetworkService } from './dealer-network.module';
import { CreateNetworkMemberDto, UpdateNetworkMarkupDto } from './dealer-network.dto';
import { applyNetworkPricing, billingEstimate, createNetworkSnapshot, networkAccountTaxRate, networkPieceTotals } from './dealer-network';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { scheduleAmounts } from '@/payment-plans/payment-schedule';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';

const actor = (id: number, role = 'dealer'): any => ({ id, role: { name: role } });
function fixture(rootMode = 'EXTERNAL', subMode = 'EXTERNAL') {
  const users: any[] = [1, 2, 3, 4].map(id => ({
    id, username: `dealer${id}`, firstName: 'Dealer', lastName: String(id), email: `dealer${id}@example.test`,
    idRole: 2, role: { name: 'dealer', markup: new Prisma.Decimal('.25') }, isActive: true,
    parentDealerId: id === 2 ? 1 : id === 3 ? 2 : null, networkMarkup: new Prisma.Decimal('.2'),
    networkTaxRate: id === 2 ? new Prisma.Decimal('.065') : id === 3 ? new Prisma.Decimal(0) : null,
    isTaxExempt: false, dealerMode: id === 1 ? rootMode : id === 2 ? subMode : 'EXTERNAL',
    dealerEarningsPlanId: id === 1 && rootMode === 'INTERNAL' ? 10 : null,
    subdealerEarningsMode: id === 2 && subMode === 'INTERNAL' ? 'MARKUP' : null,
    subdealerEarningsPercent: new Prisma.Decimal(100),
  }));
  const withParent = (user: any): any => user && { ...user,
    parentDealer: user.parentDealerId ? withParent(users.find(row => row.id === user.parentDealerId)) : null,
  };
  const db: any = {
    $queryRaw: jest.fn(async () => [{ id: 10, name: 'Test plan', revision: 1, basis: 'DEALER_MARKUP', percent: '50', isActive: true }]),
    globalParameter: { findUnique: jest.fn(async () => ({ value: new Prisma.Decimal('.07') })) },
    user: {
      findUnique: jest.fn(async ({ where }) => withParent(users.find(user => user.id === where.id))),
      findMany: jest.fn(async ({ where }) => users.filter(user =>
        (!where.id?.in || where.id.in.includes(user.id)) &&
        (where.parentDealerId === undefined || (typeof where.parentDealerId === 'number'
          ? user.parentDealerId === where.parentDealerId : where.parentDealerId.in.includes(user.parentDealerId))),
      ).map(withParent)),
      create: jest.fn(async ({ data }) => { const user = { ...data, id: 5 }; users.push(user); return user; }),
      update: jest.fn(async ({ where, data }) => Object.assign(users.find(user => user.id === where.id), data)),
    },
  };
  db.$transaction = jest.fn(async work => work(db));
  const logs = { log: jest.fn() };
  const service = new DealerNetworkService(db, logs as any, {} as any);
  const estimate = async (ownerId = 3) => {
    const snapshot = (await createNetworkSnapshot(db, users[ownerId - 1], '.07'))!;
    const piece: any = applyNetworkPricing({ qty: 1, price: new Decimal(1000), rate: new Decimal(800),
      dealerMarkupDecimal: new Decimal('.2') }, snapshot);
    const calculator = new EstimatePieceCalculatorService({} as any, {} as any);
    const totals = calculator.calculateEstimateTotals([piece], new Decimal(snapshot.nodes.at(-1)!.taxRate!), new Decimal('.08'));
    return { id: 20, idUser: ownerId, ...totals, ...networkPieceTotals([piece]), dealerNetworkSnapshot: snapshot,
      payments: [], pieces: [piece], order: null, installationJob: null };
  };
  return { users, db, logs, service, estimate };
}

describe('Taxes for each direct network sale', () => {
  it.each([
    [null, null, false, '.07'], [null, '.09', true, '0'],
    [1, null, false, '.07'], [1, null, true, '0'],
    [1, '0', false, '0'], [1, '.065', true, '.065'],
  ])('resolves parent=%s rate=%s exempt=%s without inheriting upstream taxes', (parentDealerId, tax, isTaxExempt, expected) => {
    expect(networkAccountTaxRate({ parentDealerId: parentDealerId as number | null,
      networkTaxRate: tax == null ? null : new Prisma.Decimal(tax), isTaxExempt: isTaxExempt as boolean }, '.07').eq(expected!)).toBe(true);
  });

  it.each([
    ['EXTERNAL', 'EXTERNAL', 3, '1000.00', '0.07', '1070.00'],
    ['INTERNAL', 'EXTERNAL', 3, '1200.00', '0.065', '1278.00'],
    ['INTERNAL', 'INTERNAL', 3, '1440.00', '0', '1440.00'],
    ['INTERNAL', 'INTERNAL', 2, '1440.00', '0.08', '1555.20'],
  ] as const)('charges Authentic correctly with %s / %s and owner %s', async (root, sub, owner, net, taxRate, total) => {
    const f = fixture(root, sub), estimate = await f.estimate(owner);
    expect(billingEstimate(estimate)).toMatchObject({ priceT: net, taxRate, totalPayable: total });
    expect(scheduleAmounts(estimate).material).toBe(total);
    expect(estimate.taxRate.toString()).toBe(owner === 3 ? '0' : '0.065');
    expect(estimate.dealerNetworkSnapshot.nodes.map(node => node.taxRate)).toEqual(owner === 3 ? ['0.07', '0.065', '0'] : ['0.07', '0.065']);
  });

  it('excludes upstream taxes from downstream markups and uses the billing rate for discounts', async () => {
    const f = fixture('INTERNAL'), estimate = await f.estimate();
    expect(estimate.priceT.toFixed(2)).toBe('1440.00');
    expect(estimate.customerPriceT.toFixed(2)).toBe('1728.00');
    expect(estimate.taxAmount.toString()).toBe('0');
    expect(calculateEstimateDiscount({ ...estimate, manualDiscount: {
      scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX',
    } })?.material.total).toBe('1171.50');
  });

  it('keeps saved totals and billing unchanged after changing terms; a new snapshot uses the new rate', async () => {
    const f = fixture('INTERNAL'), estimate = await f.estimate();
    const before = JSON.stringify(estimate);
    await f.service.updateMarkup(2, { markupPercent: 20, taxPercent: 0 }, actor(1));
    await f.service.updateMarkup(3, { markupPercent: 20, taxPercent: 8.25 }, actor(2));
    expect(JSON.stringify(estimate)).toBe(before);
    expect(scheduleAmounts(estimate).material).toBe('1278.00');
    const current = await f.estimate();
    expect(current.taxRate.toString()).toBe('0.0825');
    expect(current.totalPayable.toFixed(2)).toBe('1558.80');
    expect(scheduleAmounts(current).material).toBe('1200.00');
    // Los snapshots previos sin tasas por nodo conservan su tasa de cobro guardada.
    const legacy = JSON.parse(before);
    legacy.dealerNetworkSnapshot.nodes.forEach((node: any) => delete node.taxRate);
    expect(scheduleAmounts(legacy).material).toBe('1278.00');
  });

  it('saves 0% without granting a global exemption and retains tax when markup alone changes', async () => {
    const f = fixture();
    await f.service.updateMarkup(2, { markupPercent: 30, taxPercent: 0 }, actor(1));
    await f.service.updateMarkup(2, { markupPercent: 25 }, actor(1));
    expect(f.users[1].networkTaxRate.toString()).toBe('0');
    expect(f.users[1].isTaxExempt).toBe(false);
    expect(f.db.user.update.mock.calls[1][0].data).not.toHaveProperty('networkTaxRate');
    expect(f.logs.log.mock.calls[0][0]).toMatchObject({ before: { networkTaxRate: '0.065' }, after: { networkTaxRate: '0' } });
    expect(f.users[0].networkTaxRate).toBeNull();
  });

  it('creates a direct account with an independent tax rate', async () => {
    const f = fixture(); f.users[0].isTaxExempt = true;
    await f.service.create({ username: 'newchild', password: 'Example-password-123', markupPercent: 10, taxPercent: 8.25 } as any, actor(1));
    const saved = f.db.user.create.mock.calls[0][0].data;
    expect(saved.networkTaxRate.toString()).toBe('0.0825');
    expect(saved).toMatchObject({ isTaxExempt: false, parentDealerId: 1 });
  });

  it.each([[1, 3, 'dealer'], [2, 2, 'dealer'], [4, 2, 'dealer'], [1, 2, 'operator']])('denies tax changes from %s to %s as %s', async (id, target, role) => {
    const f = fixture();
    await expect(f.service.updateMarkup(target as number, { markupPercent: 20, taxPercent: 0 }, actor(id as number, role as string)))
      .rejects.toThrow(role === 'operator' ? ForbiddenException : NotFoundException);
    expect(f.db.user.update).not.toHaveBeenCalled();
  });

  it('shows all incoming taxes to admin, direct child terms to each parent and hides other terms', async () => {
    const f = fixture(); f.users[0].isTaxExempt = true;
    const admin = actor(99, 'admin');
    const data = presentApiResponse(await f.service.list(admin), admin);
    expect(data.defaultTaxPercent).toBe('7');
    expect(data.members.map((member: any) => member.taxPercent)).toEqual(['0', '6.5', '0', '7']);
    for (const [viewer, target] of [[actor(1), 2], [actor(2), 3]] as const) {
      const response = presentApiResponse(await f.service.list(viewer), viewer);
      for (const member of response.members) {
        if (member.id === target) expect(member).toHaveProperty('taxPercent');
        else expect(member).not.toHaveProperty('taxPercent');
        expect(member).not.toHaveProperty('networkTaxRate');
      }
    }
    const operator = await f.service.list(actor(99, 'operator'));
    operator.members.forEach(member => expect(member).not.toHaveProperty('taxPercent'));
    expect(presentApiResponse(f.users[1], actor(1))).not.toHaveProperty('networkTaxRate');
    await f.service.updateMarkup(3, { markupPercent: 20, taxPercent: 5 }, admin);
    expect(f.users[2].networkTaxRate.toString()).toBe('0.05');
  });
});

describe('Network sales tax input validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
  const personal = { username: 'newchild', firstName: 'New', lastName: 'Dealer', password: 'Example-password-123',
    email: 'newchild@example.test', phone: '+13055551234', street: '123 Example St', city: 'Miami', state: 'FL', postalCode: '33101' };
  for (const dto of [CreateNetworkMemberDto, UpdateNetworkMarkupDto]) {
    it.each([0, 6.5, 8.25, 100])(`${dto.name} accepts %s percent`, async taxPercent => {
      expect(await pipe.transform({ ...personal, markupPercent: 20, taxPercent, networkTaxRate: 1, isTaxExempt: true },
        { type: 'body', metatype: dto })).toMatchObject({ markupPercent: 20, taxPercent });
      const result = await pipe.transform({ ...personal, markupPercent: 20, taxPercent, networkTaxRate: 1, isTaxExempt: true }, { type: 'body', metatype: dto });
      expect(result).not.toHaveProperty('networkTaxRate');
      expect(result).not.toHaveProperty('isTaxExempt');
    });
    it.each([-1, 100.01, 1.234, '', '7', true, false, NaN, Infinity])(`${dto.name} rejects %s`, async taxPercent => {
      await expect(pipe.transform({ ...personal, markupPercent: 20, taxPercent }, { type: 'body', metatype: dto })).rejects.toThrow(BadRequestException);
    });
  }
});

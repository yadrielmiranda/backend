import { EstimatePdfHtmlBuilder } from '@/estimates/pdf/estimate-pdf-html.builder';
import { EstimatesController } from '@/estimates/estimates.controller';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { applyNetworkPricing, billingAccountId, billingEstimate, canAccessOwner, createNetworkSnapshot, dealerChain, descendantIds, networkPieceTotals, networkMaterialProfit, type NetworkSnapshot } from './dealer-network';
import { DealerNetworkService } from './dealer-network.module';
import { buildDealerEarningsReport } from '@/common/dealer-earnings';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { scheduleAmounts } from '@/payment-plans/payment-schedule';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import { preserveAgreedPiecePrices } from '@/estimates/material-revisions/material-revision-snapshot';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';

const actor = (id: number, role = 'dealer'): any => ({ id, role: { name: role } });
function fixture(rootMode: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL', subMode: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL') {
  const users: any[] = [1, 2, 3].map((id, i) => ({
    id, username: `dealer${id}`, firstName: `Dealer ${id}`, lastName: 'Test', email: `dealer${id}@example.test`, phone: '+13055551234',
    role: { name: 'dealer', markup: '.25' }, idRole: 2, isActive: true, deletedAt: null,
    parentDealerId: i ? id - 1 : null, networkMarkup: new Prisma.Decimal(i === 1 ? '.3' : i === 2 ? '.153846153846153846' : '0'),
    dealerMode: i === 0 ? rootMode : i === 1 ? subMode : 'EXTERNAL',
    dealerEarningsPlanId: i === 0 && rootMode === 'INTERNAL' ? 10 : null,
    subdealerEarningsMode: i === 1 && subMode === 'INTERNAL' ? 'AVAILABLE_PROFIT' : null,
    subdealerEarningsPercent: new Prisma.Decimal(50), isTaxExempt: false,
  }));
  const db: any = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => sql.join('').includes('DealerEarningsPlan')
      ? [{ id: 10, name: 'Root plan', revision: 1, basis: 'DEALER_MARKUP', percent: '50', isActive: true }] : []),
    globalParameter: { findUnique: jest.fn(async () => ({ value: '0' })) },
    user: {
      findUnique: jest.fn(async ({ where }) => {
        const user = users.find(u => u.id === where.id);
        return user && { ...user, parentDealer: users.find(u => u.id === user.parentDealerId) ?? null };
      }),
      findMany: jest.fn(async ({ where }) => users.filter(u => typeof where.parentDealerId === 'number'
        ? u.parentDealerId === where.parentDealerId : where.parentDealerId?.in?.includes(u.parentDealerId))),
      create: jest.fn(async ({ data }) => ({ id: 4, username: data.username, parentDealerId: data.parentDealerId })),
      update: jest.fn(async ({ where }) => ({ id: where.id })),
    },
  };
  db.$transaction = jest.fn(async work => work(db));
  return { users, db };
}
const basePiece = (qty = 1): any => ({ qty, rate: new Decimal(800), price: new Decimal(1000), regularPrice: new Decimal(1000), dealerMarkupDecimal: new Decimal('.2') });
async function estimateFixture(rootMode: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL', subMode: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL', ownerId = 3) {
  const f = fixture(rootMode, subMode);
  const snapshot = (await createNetworkSnapshot(f.db, f.users[ownerId - 1], '.07'))!;
  const piece: any = applyNetworkPricing(basePiece(), snapshot);
  const totals = networkPieceTotals([piece]);
  const estimate: any = {
    id: 10, idUser: ownerId, number: '190999', status: { name: 'Active' }, units: 1,
    dealerModeSnapshot: f.users[ownerId - 1].dealerMode, dealerNetworkSnapshot: snapshot,
    ...totals, rateT: '800', priceT: piece.price.toFixed(2), customerPriceT: piece.customerPrice.toFixed(2),
    taxRate: '.07', customerTaxRate: '.07', totalPayable: piece.price.mul('1.07').toFixed(2), customerTotalPayable: piece.customerPrice.mul('1.07').toFixed(2),
    user: f.users[ownerId - 1], pieces: [piece], payments: [], order: null, installationJob: null,
  };
  return { ...f, snapshot, piece, estimate };
}

describe('Three-level dealer network', () => {
  it.each([
    ['EXTERNAL', 'EXTERNAL', 3, 1, 'ACCOUNT_OWNER', '1000.00'],
    ['INTERNAL', 'EXTERNAL', 3, 2, 'ACCOUNT_OWNER', '1300.00'],
    ['INTERNAL', 'INTERNAL', 3, 3, 'ACCOUNT_OWNER', '1500.00'],
    ['INTERNAL', 'INTERNAL', 2, 2, 'CUSTOMER', '1560.00'],
  ] as const)('routes %s / %s, owner %s, to the correct Authentic buyer', async (rootMode, subMode, owner, buyer, type, amount) => {
    const f = await estimateFixture(rootMode, subMode, owner);
    expect(f.snapshot).toMatchObject({ billingAccountId: buyer, payerType: type });
    expect(f.estimate.idUser).toBe(owner);
    expect(billingAccountId(f.estimate)).toBe(buyer);
    expect(billingEstimate(f.estimate).priceT).toBe(amount);
    expect(scheduleAmounts(f.estimate).material).toBe(new Decimal(amount).mul('1.07').toFixed(2));
  });

  it('does not change direct-dealer or client pricing', async () => {
    const f = fixture();
    expect(await createNetworkSnapshot(f.db, f.users[0], '.07')).toBeNull();
    expect(await createNetworkSnapshot(f.db, { id: 5, role: { name: 'client' } }, '.07')).toBeNull();
    const piece = basePiece(3), estimate = { idUser: 5, priceT: '17.25' };
    expect(applyNetworkPricing(piece, null)).toBe(piece);
    expect(billingEstimate(estimate)).toBe(estimate);
  });

  it('applies each markup once, rounds unit prices and multiplies quantity once', async () => {
    const f = await estimateFixture();
    const piece: any = applyNetworkPricing(basePiece(3), f.snapshot);
    expect(piece.networkPricing.prices).toEqual(['1000.00', '1300.00', '1500.00', '1800.00']);
    expect(piece.netProfit.toFixed(2)).toBe('700.00');
    expect(piece.subtotal.toFixed(2)).toBe('4500.00');
    const totals = networkPieceTotals([piece]);
    expect(totals.networkBillingPriceT?.toFixed(2)).toBe('4500.00');
    expect(totals.networkSubdealerPriceT?.toFixed(2)).toBe('3900.00');
    expect(() => networkPieceTotals([piece, { qty: 1 }])).toThrow(BadRequestException);
  });

  it('keeps agreed prices on a revision even after the catalog changes', async () => {
    const f = await estimateFixture();
    const original: any = { ...f.piece, regularCustomerPrice: f.piece.customerPrice };
    const current: any = applyNetworkPricing({ ...basePiece(), price: new Decimal(1200), rate: new Decimal(900) }, f.snapshot);
    const revised = preserveAgreedPiecePrices(original, current, current);
    expect(revised.networkPricing).toEqual(original.networkPricing);
    expect(revised.price.toFixed(2)).toBe('1500.00');
  });

  it('uses the buyer tax exemption, not the distributor exemption', async () => {
    const f = fixture('EXTERNAL', 'EXTERNAL'); f.users[0].isTaxExempt = true;
    const snapshot = await createNetworkSnapshot(f.db, f.users[2], '.07');
    expect(snapshot?.billingTaxRate).toBe('0');
  });

  it('rejects a fourth level, cycles, internal distributors and internal children of external roots', async () => {
    const f = fixture();
    f.users.push({ ...f.users[2], id: 4, parentDealerId: 3 });
    await expect(dealerChain(f.db, 4)).rejects.toThrow('three levels');
    f.users[0].parentDealerId = 3;
    await expect(dealerChain(f.db, 3)).rejects.toThrow('cycles');
    f.users[0].parentDealerId = null; f.users[2].dealerMode = 'INTERNAL';
    await expect(dealerChain(f.db, 3)).rejects.toThrow('Distributors');
    f.users[2].dealerMode = 'EXTERNAL'; f.users[0].dealerMode = 'EXTERNAL';
    await expect(dealerChain(f.db, 3)).rejects.toThrow('internal parent');
  });

  it('permits descendants and denies parents, siblings and other branches', async () => {
    const f = fixture();
    expect(await descendantIds(f.db, actor(1))).toEqual([1, 2, 3]);
    expect(await descendantIds(f.db, actor(2))).toEqual([2, 3]);
    expect(await canAccessOwner(f.db, 3, actor(1))).toBe(true);
    expect(await canAccessOwner(f.db, 3, actor(2))).toBe(true);
    expect(await canAccessOwner(f.db, 1, actor(3))).toBe(false);
    expect(await canAccessOwner(f.db, 3, actor(8))).toBe(false);
    expect(await canAccessOwner(f.db, 3, actor(8, 'client'))).toBe(false);
  });

  it('enforces account creation type, parent and maximum depth on the server', async () => {
    const f = fixture(), logs: any = { log: jest.fn() };
    const service = new DealerNetworkService(f.db, logs, {} as any);
    const dto: any = { username: 'Newdealer', password: 'a-test-password', markupPercent: 10, dealerMode: 'INTERNAL', subdealerEarningsMode: 'MARKUP' };
    await expect(service.create({ ...dto, parentDealerId: 2 }, actor(1))).rejects.toThrow(ForbiddenException);
    await expect(service.create(dto, actor(3))).rejects.toThrow('Distributors');
    await expect(service.create(dto, actor(2))).rejects.toThrow('Only an internal dealer');
    await expect(service.create(dto, actor(1))).resolves.toMatchObject({ parentDealerId: 1 });
    expect(f.db.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dealerMode: 'INTERNAL', subdealerEarningsMode: 'MARKUP', subdealerEarningsPercent: '100', parentDealerId: 1 }) }));
  });

  it('only the direct parent or admin can change network terms', async () => {
    const f = fixture(), service = new DealerNetworkService(f.db, { log: jest.fn() } as any, {} as any);
    await expect(service.updateMarkup(3, { markupPercent: 5 }, actor(1))).rejects.toThrow(NotFoundException);
    await expect(service.updateMarkup(3, { markupPercent: 5 }, actor(2))).resolves.toEqual({ id: 3 });
    await expect(service.updateMarkup(3, { markupPercent: 5, dealerMode: 'INTERNAL' }, actor(9, 'admin'))).rejects.toThrow('Distributors');
  });
});

describe('Internal subdealer earnings and privacy', () => {
  it.each([
    ['AVAILABLE_PROFIT', '50', '125.00', '125.00', '250.00', '450.00'],
    ['AVAILABLE_PROFIT', '0', '250.00', '0.00', '250.00', '450.00'],
    ['AVAILABLE_PROFIT', '100', '0.00', '250.00', '250.00', '450.00'],
    ['AVAILABLE_PROFIT', '33.3333', '166.67', '83.33', '250.00', '450.00'],
    ['MARKUP', '100', '150.00', '200.00', '350.00', '350.00'],
  ] as const)('splits earnings from the billed sale using %s %s%%', async (mode, percent, root, child, total, company) => {
    const f = await estimateFixture(); f.snapshot.subdealerPlan = { mode, percent };
    const before = JSON.stringify(f.estimate);
    const report = buildDealerEarningsReport(f.estimate);
    expect(report.dealerEarnings?.amount).toBe(root);
    expect(report.subdealerEarnings?.amount).toBe(child);
    expect(report.materialProfits?.authenticExpectedProfit).toBe(company);
    expect(new Decimal(root).plus(child).toFixed(2)).toBe(total);
    expect(JSON.stringify(f.estimate)).toBe(before);
  });

  it('keeps real-cost earnings pending but can determine a full resale markup', async () => {
    const f = await estimateFixture(); f.snapshot.earningsPlan!.basis = 'REAL_PROFIT';
    expect(buildDealerEarningsReport(f.estimate).subdealerEarnings?.amount).toBeNull();
    f.snapshot.subdealerPlan = { mode: 'MARKUP', percent: '100' };
    expect(buildDealerEarningsReport(f.estimate).subdealerEarnings?.amount).toBe('200.00');
    expect(buildDealerEarningsReport(f.estimate).dealerEarnings?.amount).toBeNull();
    f.estimate.order = { rate: '800', rateReal: '1000', saleSubtotal: '1500' };
    expect(buildDealerEarningsReport(f.estimate).dealerEarnings?.amount).toBe('150.00');
  });

  it('applies material discounts once and excludes tax, services and installation', async () => {
    const f = await estimateFixture();
    f.estimate.installationJob = { status: 'APPROVED', quotes: [{ status: 'APPROVED', total: '4000' }] };
    f.estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
    expect(calculateEstimateDiscount(f.estimate)?.material.total).toBe('1498.00');
    expect(buildDealerEarningsReport(f.estimate).subdealerEarnings?.amount).toBe('100.00');
    f.estimate.order = { rate: '800', saleSubtotal: '1400' };
    expect(buildDealerEarningsReport(f.estimate).subdealerEarnings?.amount).toBe('100.00');
    expect(buildDealerEarningsReport(f.estimate).materialProfits?.authenticExpectedProfit).toBe('400.00');
  });

  it('does not change saved earnings when account terms change', async () => {
    const f = await estimateFixture(); f.users[1].subdealerEarningsPercent = new Prisma.Decimal(90);
    f.users[1].networkMarkup = new Prisma.Decimal('.8');
    expect(buildDealerEarningsReport(f.estimate).subdealerEarnings?.amount).toBe('125.00');
    const current = await createNetworkSnapshot(f.db, f.users[2], '.07');
    expect(current?.subdealerPlan?.percent).toBe('90');
    expect(current?.nodes[1].markup).toBe('0.8');
  });

  it.each([
    ['MARKUP', '100', '150.00', '200.00'],
    ['AVAILABLE_PROFIT', '50', '125.00', '125.00'],
  ] as const)('presents only the viewer earnings and hides upstream snapshots for %s', async (mode, percent, root, child) => {
    const f = await estimateFixture(); f.snapshot.subdealerPlan = { mode, percent };
    const payload = { ...f.estimate, ...buildDealerEarningsReport(f.estimate) };
    for (const [id, amount] of [[1, root], [2, child], [3, null]] as const) {
      const response = presentApiResponse(payload, actor(id));
      expect(response.dealerEarnings?.amount ?? null).toBe(amount);
      expect(response).not.toHaveProperty('dealerNetworkSnapshot');
      expect(response).not.toHaveProperty('networkRootPriceT');
      expect(response).not.toHaveProperty('networkSubdealerPriceT');
      expect(response.pieces[0]).not.toHaveProperty('networkPricing');
      expect(response.dealerNetwork.canPay).toBe(id === 3);
    }
    const admin = presentApiResponse(payload, actor(99, 'admin'));
    expect(admin.dealerEarnings.amount).toBe(root);
    expect(admin.subdealerEarnings.amount).toBe(child);
  });

  it('rejects checkout by an estimate owner who is not the Authentic buyer', async () => {
    const f = await estimateFixture('EXTERNAL', 'EXTERNAL');
    f.db.estimate = { findUnique: jest.fn(async () => f.estimate) };
    const workflow = new InstallationWorkflowService(f.db, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(workflow.getPaymentContext(10, 'MATERIAL', undefined, false, actor(3), f.db, { preview: true })).rejects.toThrow(NotFoundException);
    const context = await workflow.getPaymentContext(10, 'MATERIAL', undefined, false, actor(1), f.db, { preview: true });
    expect(context.baseAmount.toFixed(2)).toBe('1070.00');
  });
});


describe('Network reports and derived API views', () => {
  it('shows external members their own material margin', async () => {
    const f = await estimateFixture('EXTERNAL', 'EXTERNAL');
    expect(networkMaterialProfit(f.estimate, 1)).toBe('300.00');
    expect(networkMaterialProfit(f.estimate, 2)).toBe('200.00');
    expect(networkMaterialProfit(f.estimate, 3)).toBe('300.00');
    expect(networkMaterialProfit(f.estimate, 8)).toBeNull();
    expect(buildDealerEarningsReport(f.estimate).materialProfits?.expectedProfit).toBe('200.00');
  });

  it('does not leak upstream installments through a dealer response or discount refresh', async () => {
    const f = await estimateFixture('EXTERNAL', 'EXTERNAL');
    f.estimate.paymentPlanSnapshot = { locked: { amounts: { material: '1070.00' } } };
    f.estimate.paymentSchedule = { rows: [{ amount: '1070.00' }] };
    const response = presentApiResponse(f.estimate, actor(3));
    expect(response.paymentPlanSnapshot).toBeNull();
    expect(response.paymentSchedule).toBeNull();
    const service: any = { findOneForUser: jest.fn(async () => f.estimate) };
    const controller = new EstimatesController(service, {} as any, {} as any, {} as any);
    const refresh = await controller.getDiscount(10, { user: actor(3) } as any);
    expect(refresh.paymentSchedule).toBeNull();
    expect(refresh.dealerEarnings).toBeNull();
  });

  it.each([
    ['MARKUP', '100', '150.00', '200.00'],
    ['AVAILABLE_PROFIT', '50', '125.00', '125.00'],
  ] as const)('keeps the %s network PDF scoped to the viewer and shows staff both earnings', async (mode, percent, rootAmount, childAmount) => {
    const f = await estimateFixture();
    f.snapshot.subdealerPlan = { mode, percent };
    const e: any = { ...f.estimate, pieces: [], date: new Date(), branding: { name: 'Dealer' }, companyBranding: { name: 'Authentic' } };
    const root = EstimatePdfHtmlBuilder.build(e, 'dealer_internal', {}, 1);
    const sub = EstimatePdfHtmlBuilder.build(e, 'dealer_internal', {}, 2);
    const distributor = EstimatePdfHtmlBuilder.build(e, 'dealer_internal', {}, 3);
    const admin = EstimatePdfHtmlBuilder.build(e, 'admin', {}, 99);
    expect(root).toContain(`>$${rootAmount}</span>`);
    expect(sub).toContain(`>$${childAmount}</span>`);
    expect(distributor).not.toContain('aria-label="Dealer material earnings"');
    expect(admin).toContain('Subdealer material earnings');
    expect(sub).not.toContain('Root plan');
  });
});

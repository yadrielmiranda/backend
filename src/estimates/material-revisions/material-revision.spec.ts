import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { assertBeforeFactory, assertMaterialReadyForFactory, assertNoOpenMaterialCheckout, assertNoPendingMaterialRevision, isBeforeFactory, ownerCanAddBeforeRemeasurement } from './material-revision-policy';
import { materialRevisionBaseHash, preserveAgreedPiecePrices, projectMaterialRevision, revisionProjectSummary } from './material-revision-snapshot';
import { legacyMaterialRevisionPlan } from './material-revision-payments';
import { allocateSchedule, paymentsForSchedule } from '@/payment-plans/payment-plan';
import { buildPaymentSchedule, installmentContext, synchronizeScheduleChanges } from '@/payment-plans/payment-schedule';
import { MaterialRevisionsService } from './material-revisions.service';
import { agreementMatches, invalidateChangedAgreements, loadAgreementContent } from '@/contracts/agreement-content';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import type { AuthUser } from '@/auth/types/auth-user.type';

const admin: AuthUser = { id: 1, role: { name: 'admin' } };
const dealer: AuthUser = { id: 7, role: { name: 'dealer' } };
const d = (value: Decimal.Value) => new Decimal(value);
function estimate(): any {
  return {
    id: 35, number: '190944', idUser: 7, name: 'Revision test', status: { name: 'Ordered' },
    user: { id: 7, role: { name: 'dealer' }, dealerMode: 'INTERNAL' }, dealerModeSnapshot: 'INTERNAL',
    ownerMarkupSnapshot: '0.25', dealerEarningsPlanSnapshot: { percent: '50', type: 'REAL_PROFIT' },
    pieces: [{ id: 1, idEst: 35, mark: 'D1', qty: 1, idActiveOption: 1, idFC: 1, width: '95.5', height: '79.875',
      rate: '2377.39', price: '2377.39', customerPrice: '2971.74', dealerMarkup: '0.25', factoryUnits: [] }],
    units: 1, rateT: '2377.39', priceT: '2377.39', netProfit: '0.00', taxRate: '0', taxAmount: '0', totalPayable: '2377.39',
    customerPriceT: '2971.74', customerTaxRate: '0.07', customerTaxAmount: '208.02', customerTotalPayable: '3179.76',
    manualDiscount: { scope: 'MATERIAL', type: 'AMOUNT', value: '168', materialDiscountBasis: 'BEFORE_TAX', materialNetDiscount: '168', lockedAt: '2026-09-25' },
    order: { id: 11, idEst: 35, number: 'O11', status: { name: 'Pending' }, poNumber: null, rateReal: null },
    installationJob: null, customerCharges: [], paymentPlanSnapshot: null,
    payments: [{ id: 22, type: 'MATERIAL', sequence: 1, status: 'PAID', baseAmount: '1500.00' }],
  };
}
function beforeMeasurement(): any {
  const e = estimate(); e.order = null; e.status.name = 'Active';
  e.installationJob = { id: 40, status: 'MEASUREMENT_SCHEDULED', dealerMeasurementsAcceptedAt: null,
    measurements: [{ id: 5, status: 'PENDING', measuredAt: null }], quotes: [{ status: 'DRAFT', total: '500', lines: [] }], permit: null };
  e.payments = [{ id: 3, installationJobId: 40, type: 'INSTALLATION_DEPOSIT', status: 'PAID', baseAmount: '250.00' }];
  return e;
}
function pricing(price = 800, customerPrice = 1000, rate = 600): any {
  return { qty: 1, rate: d(rate), price: d(price), customerPrice: d(customerPrice), regularPrice: d(price), regularCustomerPrice: d(customerPrice), dealerMarkupDecimal: d('.25') };
}
function serviceFixture(e = beforeMeasurement()) {
  const rows: any[] = []; let signed = false;
  const db: any = {
    estimate: { findUnique: async () => e },
    materialRevision: { findFirst: async ({ where }: any) => rows.find(r => r.estimateId === where.estimateId && (where.id == null || where.id === r.id) && (where.activeSlot == null || where.activeSlot === r.activeSlot)) ?? null,
      findMany: async () => [...rows].sort((a, b) => b.version - a.version),
      create: async ({ data }: any) => { const row = { id: rows.length + 1, ...data, status: 'DRAFT', createdAt: new Date(), updatedAt: new Date() }; rows.push(row); return row; },
      update: async ({ where, data }: any) => { const row = rows.find(r => r.id === where.id); Object.assign(row, data); row.updatedAt = new Date(); return row; } },
    estimateRevision: { findFirst: async () => null },
    estimateAgreement: { findFirst: async () => signed ? { id: 'signed-original', signedAt: new Date() } : null, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    eventLog: { create: async () => ({}) },
    $queryRaw: async () => [{ id: e.id }],
  };
  db.$transaction = async (work: (tx: any) => any) => work(db);
  const adapter: any = { materialRevisionPieceInput: (piece: any) => ({ ...piece, dealerMarkup: Number(piece.dealerMarkup) * 100 }), materialRevisionPricing: async (p: any) => p };
  const calculator: any = { createCalculationCache: () => ({}), calculatePieceMetrics: async (input: any) => ({ ...input, ...pricing(), dealerMarkup: input.dealerMarkup }) };
  const notifications: any = { createAndSend: async () => null, createAndSendToRoles: async () => null };
  const service = new MaterialRevisionsService(db, calculator, adapter, { eligible: async () => [] } as never, notifications);
  return { service, db, rows, e, setSigned: (value: boolean) => { signed = value; } };
}

describe('Material revision scope and approval', () => {
  it('allows the owner to add a piece after the deposit, before measurement', () => assert.equal(ownerCanAddBeforeRemeasurement(beforeMeasurement(), 7), true));
  it('supports a client owner without enabling dealer pricing', () => { const e = beforeMeasurement(); e.user.role.name = 'client'; e.dealerModeSnapshot = null; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), true); });
  it('rejects a different owner', () => assert.equal(ownerCanAddBeforeRemeasurement(beforeMeasurement(), 8), false));
  it('does not treat pending checkout as a paid deposit', () => { const e = beforeMeasurement(); e.payments[0].status = 'PENDING'; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('does not require the hardcoded $250 when a lower deposit was fully paid', () => { const e = beforeMeasurement(); e.payments[0].baseAmount = '100'; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), true); });
  it('blocks additions by the owner after a field measurement starts', () => { const e = beforeMeasurement(); e.installationJob.measurements[0].measuredAt = new Date(); assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('blocks completed units even if measuredAt is absent', () => { const e = beforeMeasurement(); e.installationJob.measurements[0].status = 'COMPLETED'; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('keeps the owner restriction after an order exists', () => { const e = beforeMeasurement(); e.order = estimate().order; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('rejects a deposit from another installation', () => { const e = beforeMeasurement(); e.payments[0].installationJobId = 99; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('rejects refunded or under-review deposits', () => { const e = beforeMeasurement(); e.payments[0].refundReviewPending = true; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); e.payments[0] = { ...e.payments[0], refundReviewPending: false, status: 'REFUNDED', netPaidBaseAmount: '0', refundedAmount: '250' }; assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('does not open owner additions for waived remeasurement', () => { const e = beforeMeasurement(); e.installationJob.dealerMeasurementsAcceptedAt = new Date(); assert.equal(ownerCanAddBeforeRemeasurement(e, 7), false); });
  it('permits material-only pending orders', () => { assert.equal(isBeforeFactory(estimate()), true); assert.doesNotThrow(() => assertBeforeFactory(estimate())); });
  for (const [label, change] of [
    ['a PO', (e: any) => { e.order.poNumber = 'PO123'; }],
    ['real factory cost', (e: any) => { e.order.rateReal = '0'; }],
    ['factory units', (e: any) => { e.pieces[0].factoryUnits = [{ lineNumber: 321 }]; }],
    ['production status', (e: any) => { e.order.status.name = 'In Production'; }],
  ] as const) it(`rejects revisions once there is ${label}`, () => { const e = estimate(); change(e); assert.equal(isBeforeFactory(e), false); assert.throws(() => assertBeforeFactory(e)); });
  it('rejects an open Stripe checkout', () => assert.throws(() => assertNoOpenMaterialCheckout({ payments: [{ status: 'PENDING', stripeSessionId: 'cs_test' }] })));
  it('rejects a refund under review', () => assert.throws(() => assertNoOpenMaterialCheckout({ payments: [{ status: 'PAID', refundReviewPending: true }] })));
  it('keeps the backend ownership boundary for reads', async () => { const f = serviceFixture(); await assert.rejects(() => f.service.get(35, { id: 99, role: { name: 'client' } }), /not found/); });
  it('excludes operator links to an installation they do not own', async () => { const f = serviceFixture(); const view = await f.service.get(35, { id: 8, role: { name: 'operator' } }); assert.equal(view.installationId, null); assert.equal(view.canReviseExisting, true); assert.equal(view.canRequestSignature, false); });
  it('requires explicit not-sent confirmation for an order even without a PO', async () => { const f = serviceFixture(estimate()); await assert.rejects(() => f.service.begin(35, { reason: 'Right Active' }, admin), /Confirm/); assert.equal(f.rows.length, 0); });
  it('starts an owner addition with no signed contract and preserves the project', async () => { const f = serviceFixture(); const before = JSON.stringify(f.e); const data = await f.service.begin(35, { reason: 'Add a missing window' }, dealer); assert.equal(data.current?.status, 'DRAFT'); assert.equal(data.current?.requiresSignature, false); assert.equal(data.canReviseExisting, false); assert.equal(JSON.stringify(f.e), before); });
  it('does not let the owner replace an original piece through the new endpoint', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); await assert.rejects(() => f.service.previewPiece(35, 1, { originalPieceId: 1, piece: { qty: 1 } as any }, dealer), /cannot edit/); });
  it('does not let staff change the original quantity through Modify Piece', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Change' }, admin); await assert.rejects(() => f.service.previewPiece(35, 1, { originalPieceId: 1, piece: { qty: 2 } as any }, admin), /original quantity/); });
  it('does not allow two simultaneous drafts', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); await assert.rejects(() => f.service.begin(35, { reason: 'Add again' }, dealer), /already has/); });
  it('does not apply an accepted revision before the new customer signature', async () => { const f = serviceFixture(); f.setSigned(true); await f.service.begin(35, { reason: 'Add' }, dealer); Object.assign(f.rows[0], { status: 'PENDING_APPROVAL', proposal: {}, items: [{ key: 'test', action: 'ADD', originalPieceId: null, label: 'Window', input: { qty: 1 }, pricing: { price: '100', customerPrice: '125' }, changeDescription: [] }] }); let applied = false; (f.service as any).apply = async () => { applied = true; }; await f.service.decide(35, 1, { decision: 'APPROVE', accepted: true }, dealer); assert.equal(f.rows[0].status, 'AWAITING_SIGNATURE'); assert.equal(applied, false); });
  it('applies owner acceptance without introducing a contract requirement when none was signed', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); Object.assign(f.rows[0], { status: 'PENDING_APPROVAL', proposal: {}, items: [{ key: 'test', action: 'ADD', originalPieceId: null, label: 'Window', input: { qty: 1 }, pricing: { price: '100', customerPrice: '125' }, changeDescription: [] }] }); let applied = false; (f.service as any).apply = async () => { applied = true; }; await f.service.decide(35, 1, { decision: 'APPROVE', accepted: true }, dealer); assert.equal(applied, true); });
  it('cannot replace owner approval with an administrator approval', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, admin); await assert.rejects(() => f.service.decide(35, 1, { decision: 'APPROVE', accepted: true }, admin), /Only the estimate owner/); });
  it('cancels a revision without altering original material or payments', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); const before = JSON.stringify(f.e); await f.service.decide(35, 1, { decision: 'CANCEL' }, dealer); assert.equal(f.rows[0].status, 'CANCELED'); assert.equal(f.rows[0].activeSlot, null); assert.equal(JSON.stringify(f.e), before); });
  it('does not allow applying a revision with a missing signature', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); Object.assign(f.rows[0], { status: 'AWAITING_SIGNATURE' }); await assert.rejects(() => f.service.applySignedRevision(f.db, 35, 1, 'missing'), /valid signature/); });
  it('rejects stale project specifications before owner approval', async () => { const f = serviceFixture(); await f.service.begin(35, { reason: 'Add' }, dealer); f.rows[0].status = 'PENDING_APPROVAL'; f.e.pieces[0].idActiveOption = 2; await assert.rejects(() => f.service.decide(35, 1, { decision: 'APPROVE', accepted: true }, dealer), /project changed/); });
  it('always rolls back pricing simulations, including incidental writes', async () => { const f = serviceFixture(); let commits = 0; f.db.$transaction = async (work: any) => { const backup = structuredClone(f.e); try { const result = await work(f.db); commits++; return result; } catch (error) { for (const key of Object.keys(f.e)) delete f.e[key]; Object.assign(f.e, backup); throw error; } }; const before = JSON.stringify(f.e); const result = await (f.service as any).simulation(35, async () => { f.e.priceT = '99999'; f.e.pieces.push({ id: 2 }); return { total: '123.45' }; }); assert.deepEqual(result, { total: '123.45' }); assert.equal(commits, 0); assert.equal(JSON.stringify(f.e), before); });
  it('propagates real calculation errors instead of treating them as completed previews', async () => { const f = serviceFixture(); await assert.rejects(() => (f.service as any).simulation(35, async () => { throw new Error('Dimension not allowed'); }), /Dimension not allowed/); });
});

describe('Agreed prices, payments and factory safeguards', () => {
  it('preserves all saved prices for Left Active to Right Active when current rates are equal', () => { const saved = { rate: '2377.39', price: '2377.39', customerPrice: '2971.74', regularPrice: '2377.39', regularCustomerPrice: '2971.74' }; const result = preserveAgreedPiecePrices(saved, pricing(4000, 5000, 3500), pricing(4000, 5000, 3500)); assert.equal(result.price.toFixed(2), '2377.39'); assert.equal(result.customerPrice.toFixed(2), '2971.74'); assert.equal(result.rate.toFixed(2), '2377.39'); });
  it('adds only the changed option price difference to the saved price', () => { const result = preserveAgreedPiecePrices({ rate: 400, price: 600, customerPrice: 750 }, pricing(), pricing(850, 1062.5, 640)); assert.equal(result.price.toFixed(2), '650.00'); assert.equal(result.customerPrice.toFixed(2), '812.50'); assert.equal(result.rate.toFixed(2), '440.00'); });
  it('multiplies revised unit prices by the existing quantity', () => { const result = preserveAgreedPiecePrices({ rate: 400, price: 600, customerPrice: 750 }, pricing(), { ...pricing(850, 1062.5, 640), qty: 3 }); assert.equal(result.subtotal.toFixed(2), '1950.00'); assert.equal(result.customerSubtotal.toFixed(2), '2437.50'); });
  it('rejects negative preserved-price outcomes', () => assert.throws(() => preserveAgreedPiecePrices({ rate: 10, price: 10, customerPrice: 10 }, pricing(), pricing(1, 1, 1)), /negative/));
  it('retains the sample $3,000 total including its $168 material discount', () => { const summary = revisionProjectSummary(estimate()); assert.equal(summary.projectTotal, '3000.00'); assert.equal(summary.paid, '1500.00'); assert.equal(summary.balance, '1500.00'); });
  it('credits the paid installation deposit only once', () => { const summary = revisionProjectSummary(beforeMeasurement()); assert.equal(summary.projectTotal, '3500.00'); assert.equal(summary.paid, '250.00'); assert.equal(summary.balance, '3250.00'); });
  it('keeps the agreed material discount amount when a new piece raises the subtotal', () => { const e = estimate(); e.customerPriceT = '3471.74'; e.customerTotalPayable = '3714.76'; const summary = revisionProjectSummary(e); assert.equal(summary.projectTotal, '3535.00'); assert.equal(summary.balance, '2035.00'); });
  it('excludes separate delivery and extra charges from the revision credit', () => { const e = estimate(); e.payments.push({ type: 'DELIVERY', status: 'PAID', baseAmount: '90' }, { type: 'EXTRA', status: 'PAID', baseAmount: '30' }); assert.equal(revisionProjectSummary(e).paid, '1500.00'); });
  it('projects staged material only for the new contract, without changing the original', () => { const e = estimate(); const before = JSON.stringify(e); const projected = projectMaterialRevision(e, { proposal: { pieces: [{ id: 99, idActiveOption: 2 }], totals: { units: 2 }, installation: null } }); assert.equal(projected.pieces[0].idActiveOption, 2); assert.equal(projected.units, 2); assert.equal(JSON.stringify(e), before); assert.deepEqual(projected.payments, e.payments); });
  it('detects changed agreed data in the base hash', () => { const e = estimate(); const hash = materialRevisionBaseHash(e); e.pieces[0].idActiveOption = 2; assert.notEqual(materialRevisionBaseHash(e), hash); });
  it('ignores incidental catalog timestamps while preserving stored agreement data', () => { const e = estimate(); e.pieces[0].syst = { id: 1, updatedAt: '2026-01-01' }; const hash = materialRevisionBaseHash(e); e.pieces[0].syst.updatedAt = '2026-10-01'; assert.equal(materialRevisionBaseHash(e), hash); });
  it('preserves the dealer earnings plan snapshot as part of the protected agreement', () => { const e = estimate(); const hash = materialRevisionBaseHash(e); e.dealerEarningsPlanSnapshot.percent = '25'; assert.notEqual(materialRevisionBaseHash(e), hash); });
  it('keeps legacy receipts unchanged while crediting them against a revised order', () => { const e = estimate(); e.payments[0].baseAmount = '3000'; const original = JSON.stringify(e.payments); const plan = legacyMaterialRevisionPlan(e); const projected = paymentsForSchedule(plan, e.payments); const allocation = allocateSchedule(plan.locked!.rows, projected, ['ORDER'], true); assert.equal(allocation.paid, '3000.00'); assert.equal(allocation.balance, '0.00'); assert.equal(JSON.stringify(e.payments), original); assert.equal(e.payments[0].type, 'MATERIAL'); });
  it('does not project unrelated or mismatched payment IDs into installments', () => { const payments: any[] = [{ id: 90, type: 'DELIVERY', status: 'PAID', sequence: 1, baseAmount: '100' }]; const plan: any = { legacyPaymentCredits: [{ paymentId: 90, type: 'MATERIAL', sequence: 1 }] }; assert.deepEqual(paymentsForSchedule(plan, payments), payments); });
  it('keeps the original payment rows and adds the approved price difference separately', async () => { const e = estimate(); const original = legacyMaterialRevisionPlan(e); const before = JSON.stringify(original.locked); e.paymentPlanSnapshot = structuredClone(original); e.customerPriceT = '3471.74'; e.customerTotalPayable = '3714.76'; const db: any = { estimate: { findUnique: async () => e, update: async ({ data }: any) => Object.assign(e, data) } }; await synchronizeScheduleChanges(db, 35, { approvedMaterialRevision: true }); assert.equal(JSON.stringify(e.paymentPlanSnapshot.locked), before); assert.equal(e.paymentPlanSnapshot.adjustments[0].amount, '535.00'); assert.equal(e.payments[0].baseAmount, '1500.00'); });
  it('does not block normal payment schedules without a material revision', () => { const e = estimate(); e.paymentPlanSnapshot = legacyMaterialRevisionPlan(e); assert.equal(buildPaymentSchedule(e)?.materialRevisionPending, false); });
  it('holds next payment and factory release while a revision is pending', () => { const e = estimate(); e.paymentPlanSnapshot = legacyMaterialRevisionPlan(e); e.materialRevisions = [{ id: 1 }]; const schedule = buildPaymentSchedule(e)!; assert.equal(schedule.next, null); assert.equal(schedule.fullBalance, null); assert.equal(schedule.canRelease, false); });
  it('blocks paying an explicit installment sequence during a material revision', async () => { const e = estimate(); e.paymentPlanSnapshot = legacyMaterialRevisionPlan(e); e.materialRevisions = [{ id: 1 }]; const db: any = { estimate: { findUniqueOrThrow: async () => e } }; await assert.rejects(() => installmentContext(db, 35, 1, false), /pending material revision/); });
  it('blocks factory import or status changes while a draft awaits completion', async () => { const db: any = { estimate: { findUnique: async () => ({ materialRevisions: [{ activeSlot: 1, status: 'DRAFT' }] }) } }; await assert.rejects(() => assertMaterialReadyForFactory(db, 35), /pending material revision/); });
  it('keeps added units pending measurement before factory release', async () => { const db: any = { estimate: { findUnique: async () => ({ materialRevisions: [{ activeSlot: null, status: 'APPLIED' }], installationJob: { status: 'MEASUREMENT_PENDING', measurements: [{ id: 3 }] } }) } }; await assert.rejects(() => assertMaterialReadyForFactory(db, 35), /field measurement/); });
  it('preserves the factory flow for projects unrelated to these revisions', async () => { const db: any = { estimate: { findUnique: async () => ({ materialRevisions: [], installationJob: { status: 'MEASUREMENT_PENDING', measurements: [{ id: 3 }] } }) } }; await assert.doesNotReject(() => assertMaterialReadyForFactory(db, 35)); });
  it('allows a revised material-only order to proceed after application', async () => { const db: any = { estimate: { findUnique: async () => ({ materialRevisions: [{ activeSlot: null, status: 'APPLIED' }], installationJob: null }) } }; await assert.doesNotReject(() => assertMaterialReadyForFactory(db, 35)); });
  it('blocks original estimate editing only while a material revision is open', async () => { let open = true; const db: any = { estimate: { findUnique: async () => ({ materialRevisions: open ? [{ id: 1 }] : [] }) } }; await assert.rejects(() => assertNoPendingMaterialRevision(db, 35)); open = false; await assert.doesNotReject(() => assertNoPendingMaterialRevision(db, 35)); });
});

// Estas pruebas ejecutan los métodos de aplicación con persistencia simulada.
// No reemplazan una prueba transaccional con MySQL ni una firma real del cliente.
describe('Material revision application', () => {
  function approvedFixture() {
    const e = estimate(); const f = serviceFixture(e);
    const item: any = { key: 'right-active', action: 'UPDATE', originalPieceId: 1,
      input: { qty: 1, mark: 'D1', idActiveOption: 2 }, pricing: { rate: '2377.39', price: '2377.39', customerPrice: '2971.74' } };
    const revision: any = { id: 1, version: 1, estimateId: 35, status: 'PENDING_APPROVAL', activeSlot: 1,
      baseHash: materialRevisionBaseHash(e), approvedAt: new Date(), approvedById: 7, items: [item],
      proposal: { totals: { units: 1, rateT: '2377.39', priceT: '2377.39', customerPriceT: '2971.74' }, installation: null } };
    f.rows.push(revision);
    f.db.estimate.update = async ({ data }: any) => { Object.assign(e, data); return e; };
    f.db.order = { update: async ({ where, data }: any) => { assert.equal(where.id, e.order.id); Object.assign(e.order, data); return e.order; } };
    const calls: any[] = [];
    (f.service as any).installation.persistMaterialRevisionPiece = async (id: number, input: any, prices: any, _db: any, original: any) => {
      calls.push({ id, input, prices }); Object.assign(original, input, prices); return original;
    };
    (f.service as any).installation.stageMaterialRevisionInstallation = async (...args: any[]) => { assert.equal(args[4], null); };
    return { ...f, revision, calls };
  }
  it('applies Right Active to the same order and estimate without altering its $3,000 total or payments', async () => {
    const f = approvedFixture(); const paymentCopy = JSON.stringify(f.e.payments);
    const earningsCopy = JSON.stringify(f.e.dealerEarningsPlanSnapshot);
    await (f.service as any).apply(f.db, f.e, f.revision, 7);
    assert.equal(f.e.id, 35); assert.equal(f.e.order.id, 11); assert.equal(f.e.pieces[0].idActiveOption, 2);
    assert.equal(String(f.e.order.amount), '3000'); assert.equal(JSON.stringify(f.e.payments), paymentCopy);
    assert.equal(JSON.stringify(f.e.dealerEarningsPlanSnapshot), earningsCopy); assert.equal(f.revision.status, 'APPLIED');
    assert.equal(f.revision.activeSlot, null); assert.equal(f.calls.length, 1);
  });
  it('does not recalculate saved piece prices when applying the approved revision', async () => {
    const f = approvedFixture(); (f.service as any).calculator.calculatePieceMetrics = () => { throw new Error('Must not recalculate approved prices'); };
    await (f.service as any).apply(f.db, f.e, f.revision, 7);
    assert.equal(f.calls[0].prices.customerPrice, '2971.74'); assert.equal(f.e.pieces[0].price, '2377.39');
  });
  it('rejects an incomplete proposal before writing material', async () => {
    const f = approvedFixture(); f.revision.approvedAt = null;
    await assert.rejects(() => (f.service as any).apply(f.db, f.e, f.revision, 7), /unapproved/);
    assert.equal(f.calls.length, 0);
  });
  it('does not apply the same signed material revision twice', async () => {
    const f = approvedFixture(); f.revision.status = 'APPLIED'; f.revision.activeSlot = null;
    await f.service.applySignedRevision(f.db, 35, 1, 'already-signed'); assert.equal(f.calls.length, 0);
  });
});

describe('Added installation units and frozen installation quote', () => {
  function fixture(firstId = 100) {
    let nextId = firstId; let rebuilds = 0;
    const original: any = { id: 1, qty: 1, mark: 'W1', idSyst: 1, idConf: 1, width: '54', height: '39', idFC: 1 };
    const measurements: any[] = [{ id: 10, jobId: 40, pieceId: 1, unitIndex: 1, status: 'COMPLETED', measuredAt: new Date('2026-09-26'), widthIn: '54', heightIn: '39' }];
    const quote: any = { id: 50, jobId: 40, version: 1, status: 'DRAFT', total: '150', lines: [{ id: 1, quoteId: 50, measurementId: 10, origin: 'AUTO', adjustedAmount: '150', baseAmount: '150', sortOrder: 0 }], serviceMinimumsSnapshot: [], coverageSnapshot: null };
    const job: any = { id: 40, estimateId: 35, status: 'MEASUREMENT_PENDING', measurements, quotes: [quote] };
    const tx: any = {
      installationJob: { findUnique: async () => job, update: async ({ data }: any) => Object.assign(job, data) },
      installationMeasurement: {
        update: async ({ where, data }: any) => Object.assign(measurements.find(item => item.id === where.id), data),
        create: async ({ data }: any) => { const result = { id: nextId++, ...data }; measurements.push(result); return result; },
      },
      installationQuote: { update: async ({ data }: any) => Object.assign(quote, data), findUniqueOrThrow: async () => quote },
      installationQuoteLine: {
        deleteMany: async () => { quote.lines = []; },
        create: async ({ data }: any) => { const line = { id: nextId++, ...data }; quote.lines.push(line); return line; },
      },
    };
    const service: any = Object.create(InstallationWorkflowService.prototype);
    service.measurementCreateFromPiece = (piece: any, unitIndex: number) => ({ pieceId: piece.id, unitIndex, status: 'PENDING', widthIn: piece.width, heightIn: piece.height, sourceSnapshot: { idFC: piece.idFC } });
    service.ensureDraftQuote = async () => quote;
    service.rebuildAutomaticLines = async (_job: number, _quote: number, _tx: any, ids: number[]) => { rebuilds++; for (const id of ids) quote.lines.push({ id: nextId++, quoteId: 50, measurementId: id, origin: 'AUTO', adjustedAmount: '100', baseAmount: '100', sortOrder: 1 }); };
    service.recalculateQuoteTotals = async () => { quote.total = quote.lines.reduce((total: Decimal, line: any) => total.plus(line.adjustedAmount), d(0)).toFixed(2); return quote; };
    return { service, tx, job, quote, measurements, original, rebuilds: () => rebuilds };
  }
  it('adds every physical unit as pending measurement without disturbing an already measured unit', async () => {
    const f = fixture(); const piece = { ...f.original, id: 2, mark: 'W2', qty: 2 };
    const result = await f.service.stageMaterialRevisionInstallation(35, [{ key: 'new', piece }], 1, f.tx);
    assert.equal(f.measurements.length, 3); assert.equal(f.measurements[0].status, 'COMPLETED');
    assert.deepEqual(f.measurements.slice(1).map(m => m.status), ['PENDING', 'PENDING']);
    assert.equal(result.quote.total, '350.00'); assert.equal(result.quote.lines[0].adjustedAmount, '150');
  });
  it('applies the exact approved installation prices and relinks temporary unit IDs', async () => {
    const preview = fixture(100); const piece = { ...preview.original, id: 2, qty: 2 };
    const prepared = JSON.parse(JSON.stringify(await preview.service.stageMaterialRevisionInstallation(35, [{ key: 'new', piece }], 1, preview.tx)));
    const applied = fixture(900);
    applied.service.recalculateQuoteTotals = () => { throw new Error('Do not recalculate approved installation'); };
    const result = await applied.service.stageMaterialRevisionInstallation(35, [{ key: 'new', piece: { ...piece, id: 8 } }], 1, applied.tx, prepared);
    assert.equal(String(result.quote.total), '350'); assert.equal(applied.rebuilds(), 0);
    assert.deepEqual(result.quote.lines.slice(1).map((line: any) => line.measurementId), [900, 901]);
    assert.equal(result.quote.lines[0].measurementId, 10); assert.equal(result.quote.lines[0].adjustedAmount, '150');
  });
  it('does not invalidate completed measurements for a color-only material change', async () => {
    const f = fixture(); const result = await f.service.stageMaterialRevisionInstallation(35, [{ key: 'color', original: f.original, piece: { ...f.original, idFC: 2 } }], 1, f.tx);
    assert.equal(result, null); assert.equal(f.measurements[0].status, 'COMPLETED'); assert.equal(f.measurements[0].sourceSnapshot.idFC, 2); assert.equal(f.rebuilds(), 0);
  });
  it('requires a new field measurement when the dimensions change', async () => {
    const f = fixture(); await f.service.stageMaterialRevisionInstallation(35, [{ key: 'width', original: f.original, piece: { ...f.original, width: '60' } }], 1, f.tx);
    assert.equal(f.measurements[0].status, 'PENDING'); assert.equal(f.measurements[0].measuredAt, null);
  });
  it('rejects an unpriced installation change instead of silently repricing during approval', async () => {
    const f = fixture(); await assert.rejects(() => f.service.stageMaterialRevisionInstallation(35, [{ key: 'new', piece: { ...f.original, id: 2 } }], 1, f.tx, null), /changed after/);
  });
});

describe('Original and revised customer agreements', () => {
  async function fixture() {
    const e = estimate(); e.pieces[0].activeOption = { id: 1, name: 'Left Active' };
    e.materialRevisions = [];
    const agreements: any[] = [];
    const db: any = { estimate: { findUnique: async () => e },
      estimateAgreement: {
        findMany: async () => agreements.filter(a => !a.invalidatedAt),
        findUnique: async ({ where }: any) => agreements.find(a => a.id === where.id),
        updateMany: async ({ where, data }: any) => { for (const a of agreements) if (where.id.in.includes(a.id)) Object.assign(a, data); return { count: where.id.in.length }; },
      },
    };
    const original = await loadAgreementContent(db, 35, 'detailed');
    agreements.push({ id: 'old-signed', materialRevisionId: null, pricingMode: 'detailed', contentHash: original!.contentHash,
      materialHash: original!.materialHash, chargesSnapshot: original!.charges, signedAt: new Date('2026-09-25'), quoteFileKey: 'original.pdf' });
    const proposalPiece = { ...e.pieces[0], id: 500, idActiveOption: 2, activeOption: { id: 2, name: 'Right Active' } };
    e.materialRevisions = [{ id: 1, status: 'AWAITING_SIGNATURE', activeSlot: 1, proposal: { pieces: [proposalPiece], totals: {}, installation: null } }];
    const revised = await loadAgreementContent(db, 35, 'detailed');
    agreements.push({ id: 'new-version', materialRevisionId: 1, pricingMode: 'detailed', contentHash: revised!.contentHash,
      materialHash: revised!.materialHash, chargesSnapshot: revised!.charges, signedAt: null, quoteFileKey: 'revision.pdf' });
    return { e, db, agreements, original, revised, proposalPiece };
  }
  it('prepares the Right Active agreement without changing the original piece', async () => {
    const f = await fixture(); assert.notEqual(f.original!.materialHash, f.revised!.materialHash);
    assert.equal(f.e.pieces[0].activeOption.name, 'Left Active');
    assert.equal(f.revised!.estimate.pieces[0].activeOption.name, 'Right Active');
    assert.equal(f.revised!.materialRevisionId, 1);
  });
  it('keeps the old signed document valid while the new material is awaiting signature', async () => {
    const f = await fixture(); await invalidateChangedAgreements(f.db, 35);
    assert.equal(f.agreements[0].invalidatedAt, undefined); assert.equal(f.agreements[1].invalidatedAt, undefined);
    assert.equal(f.agreements[0].quoteFileKey, 'original.pdf');
  });
  it('invalidates only the old agreement after application and ignores temporary database piece IDs', async () => {
    const f = await fixture(); f.e.pieces = [{ ...f.proposalPiece, id: 901 }]; f.e.materialRevisions = [];
    f.agreements[1].signedAt = new Date();
    const applied = await loadAgreementContent(f.db, 35, 'detailed');
    assert.equal(agreementMatches(f.agreements[1], applied), true);
    await invalidateChangedAgreements(f.db, 35);
    assert.ok(f.agreements[0].invalidatedAt); assert.equal(f.agreements[1].invalidatedAt, undefined);
    assert.equal(f.agreements[0].quoteFileKey, 'original.pdf'); assert.ok(f.agreements[0].signedAt);
  });
});

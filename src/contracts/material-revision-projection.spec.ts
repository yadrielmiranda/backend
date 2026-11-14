import { loadAgreementContent, invalidateChangedAgreements } from './agreement-content';
import { materialChangePreview } from './material-change-preview';
import { legacyMaterialRevisionPlan } from '@/estimates/material-revisions/material-revision-payments';
import { revisionCustomer, revisionProjectSummary } from '@/estimates/material-revisions/material-revision-snapshot';
import { changeOrderInstallments } from '@/payment-plans/change-order-installments';
import { scheduleAmounts } from '@/payment-plans/payment-schedule';

function fixture() {
  const piece = (id: number, qty: number, price: number) => ({
    id, idEst: 41, mark: `W${id}`, qty, idProd: 1, idBrand: 3, idSyst: 2, idConf: 1,
    idFC: 1, idCryst: 2, idTint: 1, width: '35', height: '62',
    rate: String(price / 2), price: String(price), customerPrice: String(price),
    subtotal: String(price * qty), customerSubtotal: String(price * qty),
    regularPrice: String(price), regularCustomerPrice: String(price), dealerMarkup: '0',
  });
  const estimate: any = {
    id: 41, idUser: 7, number: 'EST-0041', name: 'Original project',
    date: new Date('2026-11-01T12:00:00Z'), expiresAt: new Date('2099-01-01T00:00:00Z'),
    customerFirstName: 'Ada', customerLastName: 'Lovelace', customerEmail: 'ada@example.test',
    customerPhone: '3055550100', customerStreet: '10 Main Street', customerAddressLine2: 'Unit 2',
    customerCity: 'Miami', customerState: 'FL', customerPostalCode: '33145',
    user: { id: 7, role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    dealerModeSnapshot: 'INTERNAL', status: { name: 'Ordered' },
    order: { id: 11, status: { name: 'Pending' } },
    units: 3, rateT: '250', priceT: '500', totalPayable: '500', taxRate: '0', taxAmount: '0',
    customerPriceT: '500', customerTaxRate: '0', customerTaxAmount: '0', customerTotalPayable: '500',
    pieces: [piece(101, 2, 100), piece(102, 1, 300)],
    installationJob: null, customerCharges: [], materialRevisions: [],
    payments: [{ id: 17, type: 'MATERIAL', status: 'PAID', baseAmount: '300', amount: '300',
      paidAt: new Date('2026-11-02T12:00:00Z'), stripeSessionId: 'private-session' }],
  };
  estimate.paymentPlanSnapshot = legacyMaterialRevisionPlan(estimate, new Date('2026-11-02T12:00:00Z'));
  const db: any = {
    estimate: {
      findUnique: jest.fn(async () => estimate),
      update: jest.fn(() => { throw new Error('Contract projections must not write estimates'); }),
    },
    materialRevision: { findFirst: jest.fn(async () => estimate.materialRevisions[0] ?? null) },
    payment: { update: jest.fn(() => { throw new Error('Contract projections must not rewrite payments'); }) },
  };
  return { estimate, db };
}

function revisionFor(estimate: any, pieces: any[], total: string, customer = revisionCustomer(estimate)) {
  const totals = {
    units: pieces.reduce((sum, piece) => sum + piece.qty, 0),
    priceT: total, totalPayable: total, customerPriceT: total, customerTotalPayable: total,
  };
  const revised = { ...estimate, ...totals, pieces };
  const plan = structuredClone(estimate.paymentPlanSnapshot);
  if (total !== '500') {
    plan.adjustments = changeOrderInstallments(plan, plan.locked.amounts, scheduleAmounts(revised),
      false, 101, 1, { materialRevision: true, materialRevisionId: 9 });
  }
  return {
    id: 9, status: 'AWAITING_SIGNATURE', activeSlot: 1,
    originalSummary: revisionProjectSummary(estimate), revisedSummary: revisionProjectSummary(revised),
    proposal: { pieces, totals, installation: null, customer, originalCustomer: revisionCustomer(estimate),
      paymentPlanSnapshot: plan },
  };
}

describe('Customer and removed material in contract projections', () => {
  it.each(['detailed', 'total'] as const)('projects customer-only changes in the %s contract without changing prices or the live estimate', async mode => {
    const { estimate, db } = fixture();
    const original = await loadAgreementContent(db, estimate.id, mode);
    estimate.materialRevisions = [revisionFor(estimate, structuredClone(estimate.pieces), '500', {
      ...revisionCustomer(estimate), name: 'Corrected project', firstName: 'Grace',
      email: 'grace@example.test', addressLine2: '',
    })];
    const before = JSON.stringify(estimate);
    const revised = await loadAgreementContent(db, estimate.id, mode);

    expect(revised!.estimate).toMatchObject({ name: 'Corrected project', customerFirstName: 'Grace',
      customerEmail: 'grace@example.test', customerAddressLine2: null });
    expect(revised!.materialHash).not.toBe(original!.materialHash);
    expect(revised!.charges).toEqual(original!.charges);
    expect(revised!.estimate.pieces).toEqual(estimate.pieces);
    expect(JSON.stringify(estimate)).toBe(before);
    expect(db.estimate.update).not.toHaveBeenCalled();
  });

  it('projects a smaller original quantity into the contract and the lower customer total', async () => {
    const { estimate, db } = fixture();
    const pieces = structuredClone(estimate.pieces);
    Object.assign(pieces[0], { qty: 1, subtotal: '100', customerSubtotal: '100' });
    estimate.materialRevisions = [revisionFor(estimate, pieces, '400')];
    const before = JSON.stringify(estimate);
    const contract = await loadAgreementContent(db, estimate.id, 'detailed');
    const preview = await materialChangePreview(db, estimate.id, 9, true);

    expect(contract!.estimate.pieces.map((piece: any) => [piece.id, piece.qty])).toEqual([[101, 1], [102, 1]]);
    expect(preview).toMatchObject({ previousTotal: '500.00', newTotal: '400.00', difference: '-100.00',
      paymentPreview: { paid: '300.00', balance: '100.00', dueAfterSigning: '100.00' } });
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('excludes a removed original piece and credits prior payments without a negative amount due', async () => {
    const { estimate, db } = fixture();
    estimate.materialRevisions = [revisionFor(estimate, [structuredClone(estimate.pieces[0])], '200')];
    const before = JSON.stringify(estimate);
    const contract = await loadAgreementContent(db, estimate.id, 'detailed');
    const preview = await materialChangePreview(db, estimate.id, 9, true);

    expect(contract!.estimate.pieces.map((piece: any) => piece.id)).toEqual([101]);
    expect(preview).toMatchObject({ previousTotal: '500.00', newTotal: '200.00', difference: '-300.00',
      paymentPreview: { paid: '300.00', balance: '0.00', dueAfterSigning: '0.00', remainingScheduled: '0.00' } });
    expect(estimate.materialRevisions[0].revisedSummary.creditBalance).toBe('100.00');
    expect(estimate.materialRevisions[0].proposal.paymentPlanSnapshot.locked).toEqual(estimate.paymentPlanSnapshot.locked);
    expect(JSON.stringify(estimate)).toBe(before);
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain('private-session');
  });

  it('keeps the same payment terms for a customer-only revision', async () => {
    const { estimate, db } = fixture();
    estimate.materialRevisions = [revisionFor(estimate, structuredClone(estimate.pieces), '500', {
      ...revisionCustomer(estimate), lastName: 'Hopper',
    })];
    const before = JSON.stringify(estimate);
    expect(await materialChangePreview(db, estimate.id, 9, true)).toMatchObject({
      previousTotal: '500.00', newTotal: '500.00', difference: '0.00',
      paymentPreview: { paid: '300.00', balance: '200.00', dueAfterSigning: '200.00' },
    });
    expect(estimate.materialRevisions[0].proposal.paymentPlanSnapshot).toEqual(estimate.paymentPlanSnapshot);
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('never returns the internal dealer payment plan when public payments are disabled', async () => {
    const { estimate, db } = fixture();
    estimate.materialRevisions = [revisionFor(estimate, [structuredClone(estimate.pieces[0])], '200')];
    const result = await materialChangePreview(db, estimate.id, 9, false);
    expect(result).toEqual({ previousTotal: '500.00', newTotal: '200.00', difference: '-300.00',
      incomplete: false, paymentPreview: null });
    expect(db.estimate.findUnique).not.toHaveBeenCalled();
  });

  it('retains the old signed contract until customer-only changes are applied, then invalidates only that old contract', async () => {
    const { estimate, db } = fixture();
    const original = await loadAgreementContent(db, estimate.id, 'detailed');
    const oldAgreement: any = { id: 'old', materialRevisionId: null, pricingMode: 'detailed',
      contentHash: original!.contentHash, materialHash: original!.materialHash, chargesSnapshot: original!.charges,
      signedAt: new Date('2026-11-02T12:00:00Z'), quoteFileKey: 'original.pdf' };
    estimate.materialRevisions = [revisionFor(estimate, structuredClone(estimate.pieces), '500', {
      ...revisionCustomer(estimate), firstName: 'Grace',
    })];
    const revised = await loadAgreementContent(db, estimate.id, 'detailed');
    const newAgreement: any = { id: 'new', materialRevisionId: 9, pricingMode: 'detailed',
      contentHash: revised!.contentHash, materialHash: revised!.materialHash, chargesSnapshot: revised!.charges,
      signedAt: new Date('2026-11-14T12:00:00Z'), quoteFileKey: 'revised.pdf' };
    const agreements = [oldAgreement, newAgreement];
    db.estimateAgreement = {
      findMany: jest.fn(async () => agreements.filter(agreement => !agreement.invalidatedAt)),
      findUnique: jest.fn(async ({ where }) => agreements.find(agreement => agreement.id === where.id)),
      updateMany: jest.fn(async ({ where, data }) => {
        agreements.filter(agreement => where.id.in.includes(agreement.id)).forEach(agreement => Object.assign(agreement, data));
      }),
    };
    await invalidateChangedAgreements(db, estimate.id);
    expect(oldAgreement.invalidatedAt).toBeUndefined();
    expect(newAgreement.invalidatedAt).toBeUndefined();

    Object.assign(estimate, revised!.estimate, { materialRevisions: [] });
    await invalidateChangedAgreements(db, estimate.id);
    expect(oldAgreement.invalidatedAt).toBeInstanceOf(Date);
    expect(newAgreement.invalidatedAt).toBeUndefined();
    expect(oldAgreement.quoteFileKey).toBe('original.pdf');
    expect(oldAgreement.signedAt.toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });
});

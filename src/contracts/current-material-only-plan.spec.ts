import { Prisma } from '@prisma/client';
import { EstimatePublicShareService } from '@/estimates/public-share/estimate-public-share.service';
import { loadAgreementContent } from './agreement-content';
import { changeOrderPaymentPreview } from './change-order-payment-preview';
import { materialChangePreview } from './material-change-preview';

function fixture(): any {
  return {
    id: 1, idUser: 7, number: 'OLD-1', name: 'Existing materials estimate',
    date: new Date('2020-01-01T00:00:00Z'), expiresAt: new Date('2099-01-01T00:00:00Z'),
    publicToken: 'detailed-token', publicTotalToken: 'total-token', publicTokenEnabled: true,
    user: { id: 7, role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    status: { name: 'Active' }, order: null, units: 1, pieces: [],
    dealerModeSnapshot: 'INTERNAL', priceT: '400.00', totalPayable: '400.00',
    customerPriceT: '400.00', customerTaxRate: '0', customerTaxAmount: '0', customerTotalPayable: '400.00',
    installationJob: null, customerCharges: [], payments: [], materialRevisions: [],
    paymentPlanSnapshot: {
      version: 1, planId: 2, name: 'Split payments',
      definition: {
        withInstallation: [
          { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
          { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
          { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
        ],
        withoutInstallation: [
          { milestone: 'ORDER', basis: 'MATERIAL', percent: 50 },
          { milestone: 'RELEASE', basis: 'MATERIAL', percent: 50 },
        ],
      },
      materialOnlyUpfront: { version: 1, threshold: '0.00' },
    },
  };
}

function database(estimate = fixture(), threshold = '700.00') {
  const db: any = {
    estimate: {
      findFirst: jest.fn().mockResolvedValue(estimate),
      findUnique: jest.fn().mockResolvedValue(estimate),
      update: jest.fn(() => { throw new Error('Read-only projection must not write'); }),
    },
    globalParameter: { findUnique: jest.fn().mockResolvedValue({ value: new Prisma.Decimal(threshold) }) },
    branding: { findFirst: jest.fn().mockResolvedValue(null) },
    notification: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  return db;
}

describe('Current material-only terms in public links and contracts', () => {
  it.each(['detailed-token', 'total-token'])('uses the current limit for an older unpaid public estimate (%s) without exposing the rule', async (token) => {
    const estimate = fixture();
    const before = JSON.stringify(estimate);
    const db = database(estimate);
    const service = new EstimatePublicShareService(db, {} as any, {} as any);

    const result = await service.findPublicEstimateByToken(token);

    expect(result.paymentSchedule?.rows).toMatchObject([{ milestone: 'ORDER', amount: '400.00' }]);
    expect(result.paymentSchedule?.rows).toHaveLength(1);
    expect(result.paymentPlanTerms?.definition.withoutInstallation).toEqual([{ milestone: 'ORDER', basis: 'MATERIAL', percent: 100 }]);
    expect(result).not.toHaveProperty('payments');
    expect(result).not.toHaveProperty('paymentPlanSnapshot');
    expect(JSON.stringify(result)).not.toMatch(/materialOnlyUpfront|threshold/);
    expect(JSON.stringify(estimate)).toBe(before);
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(db.estimate.findFirst.mock.calls[0][0].include.payments).toBe(true);
  });

  it('uses current terms consistently in contract fingerprints and both quote presentations', async () => {
    const estimate = fixture();
    const before = JSON.stringify(estimate);
    const db = database(estimate);
    const detailed = await loadAgreementContent(db, estimate.id, 'detailed', true);
    const total = await loadAgreementContent(db, estimate.id, 'total', true);
    expect(detailed?.materialHash).toBe(total?.materialHash);
    for (const result of [detailed, total]) {
      expect(result?.snapshot.paymentSchedule.rows).toHaveLength(1);
      expect(result?.snapshot.paymentSchedule.rows[0]).toMatchObject({ milestone: 'ORDER', amount: '400.00' });
      expect(JSON.stringify(result?.snapshot)).not.toMatch(/materialOnlyUpfront|threshold/);
    }
    expect(JSON.stringify(estimate)).toBe(before);
    expect(db.estimate.update).not.toHaveBeenCalled();
    expect(db.estimate.findUnique.mock.calls[0][0].include.payments).toBe(true);
  });

  it('changes unpaid contract terms when the current global limit changes without rewriting the source', async () => {
    const estimate = fixture();
    const db = database(estimate);
    const first = await loadAgreementContent(db, estimate.id, 'detailed', true);
    db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('0') });
    const second = await loadAgreementContent(db, estimate.id, 'detailed', true);
    expect(second?.snapshot.paymentSchedule.rows.map((row: any) => row.amount)).toEqual(['200.00', '200.00']);
    expect(first?.materialHash).not.toBe(second?.materialHash);
    expect(estimate.paymentPlanSnapshot.materialOnlyUpfront.threshold).toBe('0.00');
    expect(db.estimate.update).not.toHaveBeenCalled();
  });

  it('preserves a paid estimate and accurately credits the paid installment without exposing its private payment data', async () => {
    const estimate = fixture();
    estimate.payments = [{ id: 1, type: 'INSTALLMENT', status: 'PAID', sequence: 1, amount: '200.00',
      baseAmount: '200.00', paidAt: new Date('2020-01-02T00:00:00Z'), stripeSessionId: 'private-session' }];
    const before = JSON.stringify(estimate);
    const db = database(estimate);
    const service = new EstimatePublicShareService(db, {} as any, {} as any);
    const result = await service.findPublicEstimateByToken('detailed-token');
    expect(result.paymentSchedule?.rows.map(row => row.amount)).toEqual(['200.00', '200.00']);
    expect(result.paymentSchedule?.paid).toBe('200.00');
    expect(result.paymentSchedule?.balance).toBe('200.00');
    expect(JSON.stringify(result)).not.toContain('private-session');
    expect(JSON.stringify(estimate)).toBe(before);
  });

  it('uses the current limit for a readonly unpaid change-order payment preview', async () => {
    const estimate = fixture();
    const before = JSON.stringify(estimate);
    const db = database(estimate);
    expect(await changeOrderPaymentPreview(db, estimate.id, true)).toEqual({
      dueAfterSigning: '400.00', remainingScheduled: '0.00', balance: '400.00', paid: '0.00',
    });
    expect(JSON.stringify(estimate)).toBe(before);
    expect(db.estimate.update).not.toHaveBeenCalled();
  });

  it('applies the current limit after projecting an unpaid material revision, leaving the proposal and estimate intact', async () => {
    const estimate = fixture();
    const revision = {
      status: 'AWAITING_SIGNATURE', activeSlot: 1,
      originalSummary: { customerProjectTotal: '400.00' }, revisedSummary: { customerProjectTotal: '350.00' },
      proposal: { pieces: [], totals: { customerPriceT: '350.00', customerTotalPayable: '350.00', totalPayable: '350.00' }, installation: null },
    };
    const before = JSON.stringify({ estimate, revision });
    const db = database(estimate);
    db.materialRevision = { findFirst: jest.fn().mockResolvedValue(revision) };
    const result = await materialChangePreview(db, estimate.id, 9, true);
    expect(result?.paymentPreview).toEqual({ dueAfterSigning: '350.00', remainingScheduled: '0.00', balance: '350.00', paid: '0.00' });
    expect(JSON.stringify({ estimate, revision })).toBe(before);
    expect(db.estimate.update).not.toHaveBeenCalled();
  });
});

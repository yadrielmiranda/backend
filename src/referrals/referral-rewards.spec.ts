import { DealerEarningsBasis } from '@prisma/client';
import { defaultPlan, planRows, type PlanDefinition, type PlanSnapshot } from '@/payment-plans/payment-plan';
import { buildPaymentSchedule } from '@/payment-plans/payment-schedule';
import { changeOrderInstallments } from '@/payment-plans/change-order-installments';
import { calculateReferralReward, referralDealerPrice, referralMaterialSettlement, referralRewardEstimateInclude, type ReferralRewardTerms } from './referral-rewards';

const custom: ReferralRewardTerms = { version: 1, mode: 'CUSTOM_PERCENT', percent: '20' };
const external: ReferralRewardTerms = { version: 1, mode: 'EXTERNAL_MARGIN', dealerMarkup: '0.20', dealerPriceBasis: 'SAVED_UNIT_APP_BASE' };
const plan = (basis: DealerEarningsBasis): ReferralRewardTerms => ({ ...external, mode: 'DEALER_PLAN', earningsPlan: {
  version: 2, planId: 1, revision: 1, name: 'Frozen referral plan', basis, percent: '25',
} });
const amounts = { material: '1605.00', installation: '300.00', permit: '0.00', city: '0.00' };

function fixture(definition?: PlanDefinition) {
  const estimate: any = {
    id: 1, units: 2, dealerModeSnapshot: null, status: { name: 'Ordered' },
    rateT: '1000.00', priceT: '1500.00', totalPayable: '1605.00', taxRate: '0.07',
    customerPriceT: '1500.00', customerTotalPayable: '1605.00', customerTaxRate: '0.07',
    manualDiscount: null, materialRevisions: [], paymentPlanSnapshot: null,
    order: { id: 1, rate: '1000.00', saleSubtotal: '1500.00', rateReal: null, status: { name: 'Pending' } },
    pieces: [{ rate: '500.00', qty: 2 }],
    materialProcessingCost: '0.00', materialProcessingCostPending: false,
    installationJob: { status: 'MATERIAL_PAID', quotes: [{ status: 'APPROVED', total: '300.00' }], appointments: [], permit: null },
    payments: [{ id: 1, sequence: 1, type: 'MATERIAL', status: 'PAID', baseAmount: '1605.00' }],
  };
  if (definition) {
    const snapshot: PlanSnapshot = { version: 1, name: 'Saved terms', planId: 1, definition };
    snapshot.locked = { amounts: { ...amounts }, rows: planRows(snapshot, amounts, true), at: '2026-01-01' };
    estimate.paymentPlanSnapshot = snapshot;
    estimate.payments = snapshot.locked.rows.map(row => ({ id: row.sequence, sequence: row.sequence, type: 'INSTALLMENT', status: 'PAID', baseAmount: row.amount }));
  }
  return estimate;
}

describe('Referral reward pricing', () => {
  it('pays only the discounted net material margin, excluding tax and installation', () => {
    const estimate = fixture();
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '100.00', availableAmount: '100.00', reason: 'AVAILABLE' });
    expect(calculateReferralReward(estimate, external)).toEqual({ earnedAmount: '300.00', availableAmount: '300.00', reason: 'AVAILABLE' });
    estimate.installationJob.quotes[0].total = '20000';
    expect(calculateReferralReward(estimate, custom).earnedAmount).toBe('100.00');
  });

  it('uses order saleSubtotal after its discount without subtracting the discount twice', () => {
    const estimate = fixture();
    estimate.manualDiscount = { scope: 'MATERIAL', type: 'AMOUNT', value: '100', materialDiscountBasis: 'BEFORE_TAX' };
    estimate.order.saleSubtotal = '1400.00';
    estimate.payments[0].baseAmount = '1498.00';
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '80.00', availableAmount: '80.00', reason: 'AVAILABLE' });
  });

  it('uses saved unit app bases and rounds each unit before quantity or summation', () => {
    expect(referralDealerPrice([{ rate: '0.03', qty: 2 }], '0.20').toFixed(2)).toBe('0.08');
    // Multiplying the total 0.06 by 1.2 would incorrectly give 0.07.
    const estimate = fixture();
    Object.assign(estimate.order, { rate: '0.06', saleSubtotal: '1.00' });
    estimate.pieces = [{ rate: '0.03', qty: 2 }];
    expect(calculateReferralReward(estimate, external).earnedAmount).toBe('0.92');
  });

  it('holds an incomplete or stale saved base instead of using a different estimate total', () => {
    const estimate = fixture();
    estimate.pieces[0].rate = '499';
    expect(calculateReferralReward(estimate, external).reason).toBe('PENDING_REVIEW');
  });

  it('preserves the frozen own markup and plan even if account settings changed', () => {
    const estimate = fixture();
    estimate.user = { markupOverride: '0.90', dealerEarningsPlan: { percent: '100' } };
    expect(calculateReferralReward(estimate, external).earnedAmount).toBe('300.00');
    expect(calculateReferralReward(estimate, plan('DEALER_MARKUP')).earnedAmount).toBe('75.00');
    expect(calculateReferralReward(estimate, plan('EXPECTED_PROFIT')).earnedAmount).toBe('125.00');
  });

  it('waits for factory cost and material processing costs for real-profit plans', () => {
    const estimate = fixture();
    expect(calculateReferralReward(estimate, plan('REAL_PROFIT'))).toEqual({ earnedAmount: '0.00', availableAmount: '0.00', reason: 'PENDING_REAL_COST' });
    estimate.order.rateReal = '900.00';
    estimate.materialProcessingCostPending = true;
    expect(calculateReferralReward(estimate, plan('REAL_PROFIT')).reason).toBe('PENDING_COST');
    estimate.materialProcessingCostPending = false;
    estimate.materialProcessingCost = '20.00';
    expect(calculateReferralReward(estimate, plan('REAL_PROFIT')).earnedAmount).toBe('145.00');
    estimate.order.rateReal = '0';
    expect(calculateReferralReward(estimate, plan('REAL_PROFIT')).earnedAmount).toBe('370.00');
  });

  it('does not postpone an app-base formula for unrelated real costs', () => {
    const estimate = fixture(); estimate.materialProcessingCostPending = true;
    expect(calculateReferralReward(estimate, custom).reason).toBe('AVAILABLE');
    expect(calculateReferralReward(estimate, external).reason).toBe('AVAILABLE');
  });

  it('clamps a negative margin to zero and rejects malformed reward terms', () => {
    const estimate = fixture(); estimate.order.saleSubtotal = '500';
    expect(calculateReferralReward(estimate, external).earnedAmount).toBe('0.00');
    expect(calculateReferralReward(estimate, { ...custom, percent: '101' }).reason).toBe('PENDING_REVIEW');
    expect(calculateReferralReward(estimate, { ...external, dealerPriceBasis: undefined }).reason).toBe('PENDING_REVIEW');
  });
});

describe('Referral material payment eligibility', () => {
  it('requires tax-inclusive material payment, but not card surcharge', () => {
    const estimate = fixture();
    estimate.payments[0].baseAmount = '1500';
    estimate.payments[0].amount = '1700';
    expect(referralMaterialSettlement(estimate).balance.toFixed(2)).toBe('105.00');
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '100.00', availableAmount: '0.00', reason: 'PENDING_PAYMENT' });
  });

  it('releases material-only installments while installation is unpaid or under refund review', () => {
    const estimate = fixture(defaultPlan);
    estimate.payments[1].status = 'PENDING';
    expect(buildPaymentSchedule(estimate)!.balance).toBe('300.00');
    expect(calculateReferralReward(estimate, custom).availableAmount).toBe('100.00');
    Object.assign(estimate.payments[1], { status: 'PAID', netPaidBaseAmount: '250', refundedAmount: '50', refundReviewPending: true, refundReviewBaseAmount: '50' });
    expect(calculateReferralReward(estimate, custom).reason).toBe('AVAILABLE');
  });

  it('waits for the material share of a final PROJECT installment even after release is allowed', () => {
    const definition: PlanDefinition = { ...defaultPlan, withInstallation: [
      { milestone: 'ORDER', basis: 'PROJECT', percent: 50 },
      { milestone: 'RELEASE', basis: 'PROJECT', percent: 40 },
      { milestone: 'COMPLETE', basis: 'PROJECT', percent: 10 },
    ] };
    const estimate = fixture(definition);
    estimate.order.status.name = 'Delivered'; estimate.payments[2].status = 'PENDING';
    expect(buildPaymentSchedule(estimate)!.canRelease).toBe(true);
    expect(referralMaterialSettlement(estimate).balance.toFixed(2)).toBe('160.50');
    expect(calculateReferralReward(estimate, custom).reason).toBe('PENDING_PAYMENT');
  });

  it('excludes standalone permit and city fee balances', () => {
    const estimate = fixture(defaultPlan);
    estimate.paymentPlanSnapshot.adjustments = [{ sequence: 101, kind: 'CITY_FEE', milestone: 'ORDER', title: '', description: '', amount: '50.00', amounts: { ...amounts, city: '50.00' } }];
    expect(calculateReferralReward(estimate, custom).reason).toBe('AVAILABLE');
  });

  it('recomputes revised material amounts and waits for their extra installment', () => {
    const estimate = fixture(defaultPlan);
    Object.assign(estimate, { rateT: '1100', priceT: '1600', totalPayable: '1712', customerPriceT: '1600', customerTotalPayable: '1712' });
    Object.assign(estimate.order, { rate: '1100', saleSubtotal: '1600' });
    estimate.pieces = [{ rate: '550', qty: 2 }];
    const current = { ...amounts, material: '1712.00' };
    estimate.paymentPlanSnapshot.adjustments = changeOrderInstallments(estimate.paymentPlanSnapshot, amounts, current, true, 101, 1, { materialRevision: true });
    expect(referralMaterialSettlement(estimate).balance.toFixed(2)).toBe('107.00');
    expect(calculateReferralReward(estimate, external)).toEqual({ earnedAmount: '280.00', availableAmount: '0.00', reason: 'PENDING_PAYMENT' });
    estimate.payments.push({ id: 3, type: 'INSTALLMENT', sequence: 101, status: 'PAID', baseAmount: '107' });
    expect(calculateReferralReward(estimate, external).availableAmount).toBe('280.00');
  });

  it('applies revision reductions once, preserving the schedule credit', () => {
    const estimate = fixture(defaultPlan);
    Object.assign(estimate, { rateT: '900', priceT: '1400', totalPayable: '1498', customerPriceT: '1400', customerTotalPayable: '1498' });
    Object.assign(estimate.order, { rate: '900', saleSubtotal: '1400' });
    estimate.pieces = [{ rate: '450', qty: 2 }];
    estimate.paymentPlanSnapshot.adjustments = changeOrderInstallments(estimate.paymentPlanSnapshot, amounts, { ...amounts, material: '1498' }, true, 101, 1, { materialRevision: true });
    expect(calculateReferralReward(estimate, external)).toEqual({ earnedAmount: '320.00', availableAmount: '320.00', reason: 'AVAILABLE' });
    // Returning the already-credited revision overpayment is not another sale
    // discount. Refund credit is explicitly an ADDITIONAL commercial reduction.
    Object.assign(estimate.payments[0], { netPaidBaseAmount: '1498', refundedAmount: '107', refundCreditAmount: '0', refundReviewPending: false });
    expect(calculateReferralReward(estimate, external)).toEqual({ earnedAmount: '320.00', availableAmount: '320.00', reason: 'AVAILABLE' });
  });

  it('credits legacy material receipts after migration to a revised schedule', () => {
    const estimate = fixture(defaultPlan);
    estimate.payments[0].type = 'MATERIAL';
    estimate.paymentPlanSnapshot.legacyPaymentCredits = [{ paymentId: 1, type: 'MATERIAL', sequence: 1 }];
    expect(calculateReferralReward(estimate, custom).reason).toBe('AVAILABLE');
  });

  it('holds pending material revisions and unresolved material refunds', () => {
    const estimate = fixture(defaultPlan);
    estimate.materialRevisions = [{ id: 1 }];
    expect(calculateReferralReward(estimate, custom).reason).toBe('PENDING_REVIEW');
    estimate.materialRevisions = [];
    Object.assign(estimate.payments[0], { refundReviewPending: true, refundReviewBaseAmount: '20' });
    // A refund still pending at the bank can require review before principal changes.
    expect(buildPaymentSchedule(estimate)!.rows[0].balance).toBe('0.00');
    expect(calculateReferralReward(estimate, custom).reason).toBe('PENDING_REVIEW');
  });

  it.each([false, true])('reduces the net material sale for an approved tax-inclusive refund credit (scheduled=%s)', scheduled => {
    const estimate = fixture(scheduled ? defaultPlan : undefined);
    Object.assign(estimate.payments[0], { netPaidBaseAmount: '1498', refundedAmount: '107', refundCreditAmount: '107', refundReviewPending: false });
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '80.00', availableAmount: '80.00', reason: 'AVAILABLE' });
  });

  it('allocates PROJECT refund credits between material and services using frozen components', () => {
    const estimate = fixture({ ...defaultPlan, withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 100 }] });
    Object.assign(estimate.payments[0], { netPaidBaseAmount: '1714.50', refundedAmount: '190.50', refundCreditAmount: '190.50', refundReviewPending: false });
    expect(referralMaterialSettlement(estimate).refundCredit.toFixed(2)).toBe('160.50');
    expect(calculateReferralReward(estimate, custom).earnedAmount).toBe('70.00');
  });

  it.each([false, true])('reverses a fully refunded material purchase (scheduled=%s)', scheduled => {
    const estimate = fixture(scheduled ? defaultPlan : undefined);
    Object.assign(estimate.payments[0], { status: 'REFUNDED', netPaidBaseAmount: '0', refundedAmount: '1605', refundCreditAmount: '1605', refundReviewPending: false });
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '0.00', availableAmount: '0.00', reason: 'REVERSED' });
  });

  it('reverses a full material refund while its commercial review is still pending', () => {
    const estimate = fixture(defaultPlan);
    Object.assign(estimate.payments[0], { status: 'REFUNDED', netPaidBaseAmount: '0', refundedAmount: '1605', refundReviewPending: true, refundReviewBaseAmount: '1605' });
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '0.00', availableAmount: '0.00', reason: 'REVERSED' });
  });

  it('holds an uncredited partial refund until the client pays that material balance again', () => {
    const estimate = fixture(defaultPlan);
    Object.assign(estimate.payments[0], { status: 'PAID', netPaidBaseAmount: '1498', refundedAmount: '107', refundCreditAmount: '0', refundReviewPending: false });
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '100.00', availableAmount: '0.00', reason: 'PENDING_PAYMENT' });
    estimate.payments[0].netPaidBaseAmount = '1605';
    expect(calculateReferralReward(estimate, custom)).toEqual({ earnedAmount: '100.00', availableAmount: '100.00', reason: 'AVAILABLE' });
  });

  it('holds an offsetting mixed adjustment whose material allocation is unknown', () => {
    const estimate = fixture({ ...defaultPlan, withInstallation: [{ milestone: 'ORDER', basis: 'PROJECT', percent: 100 }] });
    estimate.paymentPlanSnapshot.adjustments = [{ sequence: 101, milestone: 'ORDER', title: '', description: '', amount: '7.00', planAdjustment: true,
      amounts: { ...amounts, material: '1712.00', installation: '200.00' } }];
    expect(calculateReferralReward(estimate, custom).reason).toBe('PENDING_REVIEW');
  });

  it('makes canceled orders worth zero even when payment history remains paid', () => {
    const estimate = fixture(); estimate.order.status.name = 'Canceled';
    expect(calculateReferralReward(estimate, custom).reason).toBe('REVERSED');
    expect(calculateReferralReward(estimate, custom).earnedAmount).toBe('0.00');
  });

  it('does not release money when a historic installment allocation is unknown', () => {
    const estimate = fixture(defaultPlan); estimate.payments[0].status = 'PENDING';
    estimate.paymentPlanSnapshot.locked.rows[0].amount = '1600';
    expect(calculateReferralReward(estimate, custom).reason).toBe('PENDING_REVIEW');
  });

  it('does not mutate snapshots, receipts, or the query include', () => {
    const estimate = fixture(defaultPlan); const original = JSON.stringify(estimate);
    calculateReferralReward(estimate, external);
    expect(JSON.stringify(estimate)).toBe(original);
    expect(referralRewardEstimateInclude).toMatchObject({ payments: true, pieces: { select: { rate: true, qty: true } } });
  });
});

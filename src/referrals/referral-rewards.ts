import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { calculateDealerEarnings } from '@/common/dealer-earnings';
import { calculateMaterialProfitBases } from '@/common/material-profit-bases';
import type { EarningsPlanSnapshot } from '@/earnings-plans/earnings-plan';
import { buildPaymentSchedule, scheduleAmounts, scheduleInclude } from '@/payment-plans/payment-schedule';
import { paymentsForSchedule, planSnapshot } from '@/payment-plans/payment-plan';
import { decimalAmount, paidPrincipal } from '@/payments/payment-accounting';
import { installmentProcessingComponents } from '@/payments/processing-cost-snapshot';

export type ReferralRewardTerms = {
  version: 1;
  mode: 'EXTERNAL_MARGIN' | 'CUSTOM_PERCENT' | 'DEALER_PLAN';
  percent?: string | null;
  dealerMarkup?: string | null;
  dealerPriceBasis?: 'SAVED_UNIT_APP_BASE';
  earningsPlan?: EarningsPlanSnapshot | null;
  profileRevision?: number;
  lockedAt?: string;
};

export type ReferralRewardCalculation = {
  earnedAmount: string;
  availableAmount: string;
  reason: 'AVAILABLE' | 'PENDING_PAYMENT' | 'PENDING_REVIEW' | 'PENDING_REAL_COST' | 'PENDING_COST' | 'REVERSED';
};

// Fetch from Estimate, whose lock serializes payments, refunds and material changes.
export const referralRewardEstimateInclude = {
  ...scheduleInclude,
  pieces: { select: { rate: true, qty: true } },
} satisfies Prisma.EstimateInclude;

const rounded = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const nonnegative = (value: Decimal) => Decimal.max(0, value);

export function referralDealerPrice(
  pieces: Array<{ rate: { toString(): string } | string | number; qty: number }>,
  markup: string,
) {
  const multiplier = new Decimal(markup).add(1);
  if (!multiplier.isFinite() || multiplier.lt(1) || !pieces.length) throw new Error('Invalid referral dealer price basis.');
  return pieces.reduce((total, piece) => {
    const rate = new Decimal(String(piece.rate));
    if (!rate.isFinite() || rate.lt(0) || !Number.isSafeInteger(piece.qty) || piece.qty <= 0)
      throw new Error('Invalid referral material price.');
    // Referral policy uses the saved, cent-rounded UNIT app base. Never multiply
    // the estimate total once, nor reprice historic material from today's catalog.
    return total.add(rounded(rate.mul(multiplier)).mul(piece.qty));
  }, new Decimal(0));
}

type MaterialSettlement = {
  gross: Decimal;
  balance: Decimal;
  refundCredit: Decimal;
  review: boolean;
  fullyRefunded: boolean;
};

/** Material includes its sales tax; card surcharge and unrelated services do not. */
export function referralMaterialSettlement(estimate: any): MaterialSettlement {
  const amounts = scheduleAmounts(estimate);
  const gross = new Decimal(amounts.material);
  const snapshot = planSnapshot(estimate.paymentPlanSnapshot);
  const payments = estimate.payments ?? [];
  if (!snapshot) {
    const material = payments.filter((payment: any) => payment.type === 'MATERIAL');
    const received = material.reduce((sum: Decimal, payment: any) => sum.add(paidPrincipal(payment)), new Decimal(0));
    const refundCredit = material.reduce((sum: Decimal, payment: any) => sum.add(decimalAmount(payment.refundCreditAmount)), new Decimal(0));
    return {
      gross, refundCredit,
      balance: nonnegative(gross.minus(received).minus(refundCredit)),
      review: material.some((payment: any) => payment.refundReviewPending),
      fullyRefunded: received.eq(0) && material.some((payment: any) => decimalAmount(payment.refundedAmount).gt(0)),
    };
  }

  const schedule = buildPaymentSchedule(estimate)!;
  const projectedPayments = paymentsForSchedule(snapshot, payments);
  const withInstallation = Boolean(estimate.installationJob && estimate.installationJob.status !== 'CANCELED');
  let balance = new Decimal(0), refundCredit = new Decimal(0), review = false, materialRefund = false;
  const components = (row: any, amount: Decimal) => installmentProcessingComponents({
    snapshot, amounts, withInstallation,
    row: { ...row, balance: amount.toFixed(2) },
  });
  for (const row of schedule.rows) {
    const remaining = new Decimal(row.balance);
    const allocated = components(row, remaining);
    if (allocated.allocationPending) review = true;
    balance = balance.add(allocated.material);
    const original = new Decimal('originalAmount' in row ? row.originalAmount! : row.amount);
    if (original.lte(0)) continue; // Already applied by allocateSchedule as a credit.
    const matching = projectedPayments.filter(payment => payment.type === 'INSTALLMENT' && payment.sequence === row.sequence);
    const credits = matching.reduce((sum, payment) => sum.add(decimalAmount(payment.refundCreditAmount)), new Decimal(0));
    const hasRefund = matching.some(payment => decimalAmount(payment.refundedAmount).gt(0));
    if (!credits.gt(0) && !hasRefund && row.status !== 'REVIEW') continue;
    const originalComponents = components(row, original);
    if (originalComponents.allocationPending) {
      review = true;
      continue;
    }
    const affectsMaterial = new Decimal(originalComponents.material).gt(0);
    if (affectsMaterial && row.status === 'REVIEW') review = true;
    materialRefund ||= affectsMaterial && hasRefund;
    if (credits.gt(0)) {
      // More credit than this row's obligation carries to other rows. Its material
      // share is ambiguous, so keep it under review instead of inventing earnings.
      if (credits.gt(original)) { review = true; continue; }
      const creditComponents = components(row, credits);
      if (creditComponents.allocationPending) review = true;
      refundCredit = refundCredit.add(creditComponents.material);
    }
  }
  // A reviewed advance refund is a project-wide credit; no component allocation
  // is recorded for it. Do not attribute it to material by guessing.
  if (projectedPayments.some(payment => ['INSTALLATION_DEPOSIT', 'PERMIT'].includes(payment.type) && decimalAmount(payment.refundCreditAmount).gt(0)))
    review = true;
  const coveredMaterial = nonnegative(gross.minus(refundCredit).minus(balance));
  return { gross, balance, refundCredit, review, fullyRefunded: materialRefund && coveredMaterial.eq(0) };
}

const zero = (reason: ReferralRewardCalculation['reason']): ReferralRewardCalculation => ({
  earnedAmount: '0.00', availableAmount: '0.00', reason,
});

/** Shared net revenue basis for the reward and the company's financial report. */
export function referralMaterialSale(estimate: any, settlement = referralMaterialSettlement(estimate)) {
  const billedSale = rounded(String(estimate.order.saleSubtotal));
  if (!billedSale.isFinite() || billedSale.lt(0)) throw new Error('Invalid material sale.');
  // The order already includes promotions, discounts and approved revisions.
  // Refund credits are ADDITIONAL commercial forgiveness, inclusive of tax.
  const netCredit = settlement.gross.gt(0)
    ? rounded(settlement.refundCredit.mul(billedSale).div(settlement.gross))
    : new Decimal(0);
  const materialRefundCredit = Decimal.min(billedSale, nonnegative(netCredit));
  return { billedSale, materialRefundCredit, sale: billedSale.minus(materialRefundCredit) };
}

/** Computes the current target balance; the caller records deltas, never recredits a sale. */
export function calculateReferralReward(estimate: any, terms: ReferralRewardTerms): ReferralRewardCalculation {
  if (!estimate?.order) return zero('PENDING_PAYMENT');
  const canceled = [estimate.status?.name, estimate.order.status?.name]
    .some(status => ['Canceled', 'Cancelled', 'CANCELED', 'CANCELLED'].includes(status));
  if (canceled) return zero('REVERSED');
  try {
    if (terms.version !== 1) return zero('PENDING_REVIEW');
    const settlement = referralMaterialSettlement(estimate);
    if (settlement.fullyRefunded) return zero('REVERSED');
    const appBase = rounded(String(estimate.order.rate));
    if (appBase.lt(0) || !appBase.isFinite())
      return zero('PENDING_REVIEW');
    const { sale } = referralMaterialSale(estimate, settlement);
    let amount: Decimal;
    if (terms.mode === 'CUSTOM_PERCENT') {
      const percent = new Decimal(terms.percent ?? 'NaN');
      if (!percent.isFinite() || percent.lt(0) || percent.gt(100)) return zero('PENDING_REVIEW');
      amount = rounded(sale.minus(appBase).mul(percent).div(100));
    } else if (terms.mode === 'EXTERNAL_MARGIN' || terms.mode === 'DEALER_PLAN') {
      if (terms.dealerPriceBasis !== 'SAVED_UNIT_APP_BASE' || terms.dealerMarkup == null)
        return zero('PENDING_REVIEW');
      const pieces = estimate.pieces ?? [];
      const savedBase = pieces.reduce((total: Decimal, piece: any) => total.add(new Decimal(String(piece.rate)).mul(piece.qty)), new Decimal(0));
      if (!rounded(savedBase).eq(appBase)) return zero('PENDING_REVIEW');
      const dealerPrice = referralDealerPrice(pieces, terms.dealerMarkup);
      if (terms.mode === 'EXTERNAL_MARGIN') amount = rounded(sale.minus(dealerPrice));
      else {
        if (!terms.earningsPlan) return zero('PENDING_REVIEW');
        const profits = calculateMaterialProfitBases({ customerPrice: sale, appBasePrice: appBase, dealerPrice,
          realFactoryCost: estimate.order.rateReal == null ? null : String(estimate.order.rateReal) });
        const earnings = calculateDealerEarnings(terms.earningsPlan, profits, {
          amount: String(estimate.materialProcessingCost ?? 0), pending: estimate.materialProcessingCostPending === true,
        });
        if (earnings.amount == null) return zero(earnings.status === 'PENDING_COST' ? 'PENDING_COST' : 'PENDING_REAL_COST');
        amount = new Decimal(earnings.amount);
      }
    } else return zero('PENDING_REVIEW');
    const earnedAmount = nonnegative(amount).toFixed(2);
    const pendingRevision = estimate.materialRevisions?.some((revision: any) => revision.activeSlot === undefined || revision.activeSlot === 1);
    const reason = settlement.review || pendingRevision ? 'PENDING_REVIEW'
      : settlement.balance.gt(0) ? 'PENDING_PAYMENT' : 'AVAILABLE';
    return { earnedAmount, availableAmount: reason === 'AVAILABLE' ? earnedAmount : '0.00', reason };
  } catch {
    // Malformed historic snapshots or unknown allocations cannot release money.
    return zero('PENDING_REVIEW');
  }
}

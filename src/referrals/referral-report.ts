import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { buildDealerEarningsReport, type MaterialProfitsSummary } from '@/common/dealer-earnings';
import { calculateReferralReward, referralMaterialSale, type ReferralRewardTerms } from './referral-rewards';

export type ReferralCostsSummary = {
  amount: string | null;
  status: 'CALCULATED' | 'PENDING_REAL_COST' | 'PENDING_COST' | 'PENDING_REVIEW' | 'REVERSED';
};

export type ReferralMaterialProfitsSummary = MaterialProfitsSummary & {
  materialRefundCredit?: string;
};

// Only the frozen calculation terms are needed; never fetch payout destinations.
export const referralReportOrderInclude = {
  status: true,
  referralReward: { select: { terms: true } },
} satisfies Prisma.OrderInclude;

export const referralReportMaterialRelations = {
  materialRevisions: { where: { activeSlot: 1 }, select: { id: true }, take: 1 },
  pieces: { select: { rate: true, qty: true } },
} satisfies Prisma.EstimateInclude;

function directMaterialProfits(estimate: any, order: any): MaterialProfitsSummary {
  const sale = new Decimal(String(order.saleSubtotal));
  const expected = sale.minus(String(order.rate));
  const real = order.rateReal == null ? null : sale.minus(String(order.rateReal));
  const processingPending = estimate.materialProcessingCostPending === true;
  const processingCost = new Decimal(String(estimate.materialProcessingCost ?? 0));
  const netReal = real == null || processingPending ? null : real.minus(processingCost);
  return {
    expectedProfit: expected.toFixed(2), realProfit: real?.toFixed(2) ?? null,
    netProfitD: '0.00', processingCost: processingPending ? null : processingCost.toFixed(2),
    processingCostStatus: processingPending ? 'PENDING' : 'CONFIRMED',
    netRealProfit: netReal?.toFixed(2) ?? null,
    authenticExpectedProfit: expected.toFixed(2), authenticRealProfit: netReal?.toFixed(2) ?? null,
  };
}

/** Private financial report: reward liability exists before it is available to withdraw. */
export function buildMaterialEarningsReport(estimate: any, order = estimate?.order) {
  const report = buildDealerEarningsReport(estimate, order);
  const reward = order?.referralReward;
  if (!reward) return report;
  const current = { ...estimate, order };
  const calculation = calculateReferralReward(current, reward.terms as ReferralRewardTerms);
  const pending = ['PENDING_REAL_COST', 'PENDING_COST', 'PENDING_REVIEW'].includes(calculation.reason);
  const referralCosts: ReferralCostsSummary = {
    amount: pending ? null : calculation.earnedAmount,
    status: pending ? calculation.reason as ReferralCostsSummary['status']
      : calculation.reason === 'REVERSED' ? 'REVERSED' : 'CALCULATED',
  };
  const profits = report.materialProfits ?? directMaterialProfits(estimate, order);
  let materialRefundCredit: Decimal | null;
  try { materialRefundCredit = referralMaterialSale(current).materialRefundCredit; }
  catch { materialRefundCredit = null; }
  const afterReferral = (grossCompanyProfit: string | null) =>
    grossCompanyProfit == null || referralCosts.amount == null || materialRefundCredit == null ? null
      : new Decimal(grossCompanyProfit).minus(materialRefundCredit).minus(referralCosts.amount).toFixed(2);
  return {
    ...report,
    referralCosts,
    materialProfits: {
      ...profits,
      ...(materialRefundCredit == null ? {} : { materialRefundCredit: materialRefundCredit.toFixed(2) }),
      authenticExpectedProfit: afterReferral(profits.authenticExpectedProfit),
      authenticRealProfit: afterReferral(profits.authenticRealProfit),
    },
  };
}

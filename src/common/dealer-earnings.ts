import { networkSnapshot } from '@/dealer-network/dealer-network';
import { BadRequestException } from '@nestjs/common';
import { DealerEarningsBasis } from '@prisma/client';
import Decimal from 'decimal.js';
import { calculateMaterialProfitBases, MaterialProfitBases } from './material-profit-bases';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import { EarningsPlanSnapshot, validateEarningsRule } from '@/earnings-plans/earnings-plan';

function savedPlan(value: unknown): EarningsPlanSnapshot {
  // Cada operación usa sus condiciones guardadas, nunca el plan actual del dealer.
  if (value == null) throw new BadRequestException('This internal dealer estimate has no saved earnings plan.');
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid saved earnings plan.');
  const plan = value as Partial<EarningsPlanSnapshot>;
  if (plan.version !== 2) throw new BadRequestException('Unsupported saved earnings plan.');
  const rule = validateEarningsRule(plan.basis, plan.percent);
  const sourceKnown = Number.isSafeInteger(plan.planId) && plan.planId! > 0 &&
    Number.isSafeInteger(plan.revision) && plan.revision! > 0;
  const noPreviousPlan = plan.planId === null && plan.revision === null && rule.percent === '0';
  if (!(sourceKnown || noPreviousPlan) ||
    typeof plan.name !== 'string' || !plan.name.trim())
    throw new BadRequestException('Invalid saved earnings plan.');
  return { ...plan, ...rule } as EarningsPlanSnapshot;
}

/** Las fórmulas de participación usan bases ya calculadas; no repiten las restas. */
export function calculateDealerEarnings(plan: EarningsPlanSnapshot, profits: MaterialProfitBases) {
  const rule = validateEarningsRule(plan.basis, plan.percent);
  const basis = rule.basis === DealerEarningsBasis.REAL_PROFIT
    ? profits.realProfit
    : rule.basis === DealerEarningsBasis.EXPECTED_PROFIT
      ? profits.expectedProfit
      : profits.netProfitD;
  const amount = basis == null ? null : basis.mul(rule.percent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const basisLabel = rule.basis === DealerEarningsBasis.DEALER_MARKUP ? 'dealer markup'
    : rule.basis === DealerEarningsBasis.REAL_PROFIT ? 'real material profit' : 'expected material profit';
  return {
    planId: plan.planId,
    planName: plan.name,
    basis: rule.basis,
    percent: rule.percent,
    label: `${plan.name} · ${rule.percent}% of ${basisLabel}`,
    status: amount == null ? 'PENDING_REAL_COST' as const : 'CALCULATED' as const,
    amount: amount?.toFixed(2) ?? null,
  };
}

export type DealerEarningsSummary = Omit<ReturnType<typeof calculateDealerEarnings>, 'basis'> & { basis: DealerEarningsBasis | 'AVAILABLE_PROFIT' };

/** Proyección común para estimados, órdenes y PDF. Solo remunera materiales de dealers internos. */
export function buildDealerEarningsReport(estimate: any, order = estimate?.order) {
  const network = networkSnapshot(estimate);
  if (network) {
    const discount = calculateEstimateDiscount(estimate);
    const sale = new Decimal(String(order?.saleSubtotal ?? estimate.networkBillingPriceT ?? 0));
    const netSale = order ? sale : sale.minus(discount?.material.netDiscount ?? 0);
    const rootPrice = new Decimal(String(estimate.networkRootPriceT ?? 0));
    const subdealerPrice = new Decimal(String(estimate.networkSubdealerPriceT ?? 0));
    const appBasePrice = String(order?.rate ?? estimate.rateT);
    const realFactoryCost = order?.rateReal == null ? null : String(order.rateReal);
    // La participación original se calcula sobre el precio ofrecido al subdealer.
    if (network.rootMode !== 'INTERNAL') {
      const expected = netSale.minus(appBasePrice);
      const real = realFactoryCost == null ? null : netSale.minus(realFactoryCost);
      return { dealerEarnings: null, subdealerEarnings: null, materialProfits: {
        expectedProfit: expected.toFixed(2), realProfit: real?.toFixed(2) ?? null, netProfitD: '0.00',
        authenticExpectedProfit: expected.toFixed(2), authenticRealProfit: real?.toFixed(2) ?? null,
      } };
    }
    const rootProfits = calculateMaterialProfitBases({
      customerPrice: network.subdealerPlan ? subdealerPrice : netSale,
      appBasePrice, dealerPrice: rootPrice, realFactoryCost,
    });
    const earnings = calculateDealerEarnings(savedPlan(network.earningsPlan), rootProfits);
    let subdealerEarnings: DealerEarningsSummary | null = null;
    let totalEarnings = earnings.amount == null ? null : new Decimal(earnings.amount);
    if (network.subdealerPlan) {
      const markup = netSale.minus(subdealerPrice);
      const pool = totalEarnings?.plus(markup) ?? null;
      // MARKUP se conoce aunque el plan del superior espere el costo real de fábrica.
      const amount = network.subdealerPlan.mode === 'MARKUP' ? markup
        : pool?.mul(network.subdealerPlan.percent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) ?? null;
      const remaining = pool == null || amount == null ? null : pool.minus(amount);
      earnings.amount = remaining?.toFixed(2) ?? null;
      earnings.status = remaining == null ? 'PENDING_REAL_COST' : 'CALCULATED';
      totalEarnings = pool;
      subdealerEarnings = {
        planId: null, planName: '', label: '',
        basis: network.subdealerPlan.mode === 'MARKUP' ? 'DEALER_MARKUP' : 'AVAILABLE_PROFIT',
        percent: network.subdealerPlan.percent,
        status: amount == null ? 'PENDING_REAL_COST' : 'CALCULATED', amount: amount?.toFixed(2) ?? null,
      };
    }
    const profits = calculateMaterialProfitBases({ customerPrice: netSale, appBasePrice, dealerPrice: rootPrice, realFactoryCost });
    return { dealerEarnings: earnings, subdealerEarnings, materialProfits: {
      expectedProfit: profits.expectedProfit.toFixed(2), realProfit: profits.realProfit?.toFixed(2) ?? null,
      netProfitD: profits.netProfitD.toFixed(2),
      authenticExpectedProfit: totalEarnings == null ? null : profits.expectedProfit.minus(totalEarnings).toFixed(2),
      authenticRealProfit: totalEarnings == null || profits.realProfit == null ? null : profits.realProfit.minus(totalEarnings).toFixed(2),
    } };
  }

  const mode = order?.dealerModeSnapshot ?? estimate?.dealerModeSnapshot;
  if (mode !== 'INTERNAL') return { dealerEarnings: null, materialProfits: null };

  const discount = calculateEstimateDiscount(estimate);
  const customerDiscount = discount?.payer === 'CUSTOMER' ? discount.material.netDiscount : '0';
  const dealerDiscount = discount?.payer === 'ACCOUNT_OWNER' ? discount.material.netDiscount : '0';
  const customerPrice = order?.saleSubtotal ?? new Decimal(String(estimate.customerPriceT)).minus(customerDiscount);
  const dealerPrice = new Decimal(String(estimate.priceT)).minus(dealerDiscount);
  const appBasePrice = order?.rate ?? estimate.rateT;
  const persistedMargin = estimate.netProfitD != null
    ? new Decimal(String(estimate.netProfitD))
      .plus(String(customerPrice)).minus(String(estimate.customerPriceT)).plus(dealerDiscount)
    : undefined;
  const profits = calculateMaterialProfitBases({
    customerPrice: String(customerPrice),
    appBasePrice: String(appBasePrice),
    dealerPrice,
    realFactoryCost: order?.rateReal == null ? null : String(order.rateReal),
    netProfitD: persistedMargin,
  });
  const earnings = calculateDealerEarnings(savedPlan(estimate.dealerEarningsPlanSnapshot), profits);
  return {
    dealerEarnings: earnings,
    // Estos importes son privados de administración; no se envían a clientes o dealers.
    materialProfits: {
      expectedProfit: profits.expectedProfit.toFixed(2),
      realProfit: profits.realProfit?.toFixed(2) ?? null,
      netProfitD: profits.netProfitD.toFixed(2),
      authenticExpectedProfit: earnings.amount == null ? null : profits.expectedProfit.minus(earnings.amount).toFixed(2),
      authenticRealProfit: earnings.amount == null || profits.realProfit == null ? null : profits.realProfit.minus(earnings.amount).toFixed(2),
    },
  };
}

export type MaterialProfitsSummary = NonNullable<ReturnType<typeof buildDealerEarningsReport>['materialProfits']>;

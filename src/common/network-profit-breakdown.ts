import Decimal from 'decimal.js';
import { networkMaterialProfit, networkSnapshot, type NetworkLevel } from '@/dealer-network/dealer-network';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import { buildEstimateCustomerChargeSummary } from '@/estimates/estimate-customer-charges.summary';
import { buildEstimateInstallationSummary } from '@/estimates/reporting/estimate-installation-summary';
import { buildMaterialEarningsReport } from '@/referrals/referral-report';

export type NetworkProfitStatus = 'CALCULATED' | 'PENDING_REAL_COST' | 'PENDING_COST' | 'PENDING_REVIEW';
export type NetworkProfitAmount = { amount: string | null; status: NetworkProfitStatus };
export type NetworkProfitBreakdown = {
  version: 1;
  members: Array<{
    userId: number;
    username: string;
    level: NetworkLevel;
    mode: 'INTERNAL' | 'EXTERNAL';
    material: NetworkProfitAmount;
    services: NetworkProfitAmount;
    total: NetworkProfitAmount;
  }>;
  company: {
    materialExpected: NetworkProfitAmount;
    materialReal: NetworkProfitAmount;
    installation: NetworkProfitAmount;
    expectedTotal: NetworkProfitAmount;
  };
};

function money(value: unknown, pending: NetworkProfitStatus = 'PENDING_REVIEW'): NetworkProfitAmount {
  if (value == null || value === '') return { amount: null, status: pending };
  try {
    const amount = new Decimal(String(value));
    if (amount.isFinite()) return { amount: amount.toFixed(2), status: 'CALCULATED' };
  } catch { /* Historical incomplete amounts remain pending. */ }
  return { amount: null, status: 'PENDING_REVIEW' };
}

function sum(left: NetworkProfitAmount, right: NetworkProfitAmount): NetworkProfitAmount {
  if (left.amount == null) return { ...left };
  if (right.amount == null) return { ...right };
  return money(new Decimal(left.amount).plus(right.amount));
}

/** Administrative projection only. It never changes pricing, payments or saved terms.
 * Services are quoted margins before processing fees, not amounts already paid out.
 */
export function buildNetworkProfitBreakdown(estimate: any, order = estimate?.order): NetworkProfitBreakdown | null {
  const network = networkSnapshot(estimate);
  if (!network) return null;
  const report = buildMaterialEarningsReport(estimate, order);
  const discount = calculateEstimateDiscount(estimate);
  const job = estimate.installationJob?.status === 'CANCELED' ? null : estimate.installationJob;
  const quote = job?.quotes?.find((candidate: any) => candidate.status !== 'REJECTED');
  const quotePending = Boolean(quote?.needsRecalculation);
  const installationSummary = estimate.installationSummary ?? (job?.quotes
    ? buildEstimateInstallationSummary({ ...job, quotes: quote ? [quote] : [] }) : null);
  const owner = network.nodes.at(-1)!;
  const customerCharges = estimate.customerChargesSummary ?? buildEstimateCustomerChargeSummary({
    estimate: { ...estimate, user: { ...estimate.user, role: { name: 'dealer' }, dealerMode: owner.mode } },
    installation: installationSummary,
    charges: estimate.customerCharges ?? [],
  });
  const servicePending = quotePending || Boolean(job && !installationSummary) || !customerCharges ||
    customerCharges.customerTotalIncomplete || customerCharges.systemTotalIncomplete ||
    customerCharges.lines.some(line => line.needsReview);
  const ownerServices = servicePending ? money(null) : money(
    new Decimal(customerCharges.customerTotal).minus(customerCharges.systemTotal),
  );
  // An external buyer keeps a company discount on its own purchase. It does not
  // automatically belong to the distributor who prepared the customer's quote.
  const buyerServiceDiscount = discount?.payer === 'ACCOUNT_OWNER'
    ? new Decimal(discount.installation.discount).plus(discount.permit.discount).plus(discount.city.discount)
    : new Decimal(0);
  const members = network.nodes.map((node, index) => {
    const earnings = index === 0 ? report.dealerEarnings : report.subdealerEarnings;
    const material = node.mode === 'EXTERNAL'
      ? money(networkMaterialProfit(estimate, node.id, discount?.material.netDiscount ?? '0'))
      : money(earnings?.amount, earnings?.status ?? 'PENDING_REVIEW');
    let services = node.id === owner.id ? ownerServices : money('0');
    if (node.mode === 'EXTERNAL' && node.id === network.billingAccountId) {
      services = sum(services, quotePending && buyerServiceDiscount.gt(0) ? money(null) : money(buyerServiceDiscount));
    }
    return { userId: node.id, username: node.username, level: node.level, mode: node.mode,
      material, services, total: sum(material, services) };
  }).reverse();

  const profits = report.materialProfits;
  const referralStatus = 'referralCosts' in report ? report.referralCosts?.status : null;
  const pendingMaterial: NetworkProfitStatus = referralStatus === 'PENDING_REVIEW' ? 'PENDING_REVIEW'
    : referralStatus === 'PENDING_COST' || estimate.materialProcessingCostPending ? 'PENDING_COST'
    : members.find(member => member.material.amount == null)?.material.status ?? 'PENDING_REAL_COST';
  const materialExpected = money(profits?.authenticExpectedProfit, pendingMaterial);
  const materialReal = money(profits?.authenticRealProfit, pendingMaterial);
  let installation = money('0');
  if (job) {
    const provider = quote?.providerCostSnapshot;
    if (!quote || quotePending || provider?.schema !== 1 || provider.total == null) installation = money(null);
    else {
      const sale = money(quote.total), cost = money(provider.total);
      installation = sale.amount == null || cost.amount == null ? money(null)
        : money(new Decimal(sale.amount).minus(cost.amount).minus(discount?.installation.discount ?? '0'));
    }
  }
  return { version: 1, members, company: {
    materialExpected, materialReal, installation, expectedTotal: sum(materialExpected, installation),
  } };
}

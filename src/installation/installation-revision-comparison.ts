import Decimal from 'decimal.js';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';

type DiscountEstimate = Parameters<typeof calculateEstimateDiscount>[0];
type DiscountInstallation = NonNullable<
  Parameters<typeof calculateEstimateDiscount>[1]
>;
type Quote = {
  id: number;
  version: number;
  status: string;
  total: DiscountEstimate['totalPayable'];
  approvedAt?: Date | string | null;
  submittedAt?: Date | string | null;
};
type ComparisonJob = {
  estimate: DiscountEstimate;
  quotes: Quote[];
  revisions: {
    id: number;
    quoteId: number;
    originalTotals: unknown;
    revisedTotals: unknown;
  }[];
  permit?: DiscountInstallation['permit'];
};
type MaterialSnapshot = DiscountEstimate & {
  units: number;
  taxAmount: string;
  customerTaxAmount: string;
};

const money = (value: DiscountEstimate['totalPayable']) =>
  new Decimal(value?.toString() ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

function snapshot(value: unknown): MaterialSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as MaterialSnapshot;
  return result.totalPayable != null && result.priceT != null ? result : null;
}

/** Comparación de lectura: utiliza los precios guardados y el cálculo de descuentos vigente. */
export function buildInstallationRevisionComparison(job: ComparisonJob) {
  const quotes = [...job.quotes].sort((a, b) => b.version - a.version);
  const revisedQuote = quotes[0];
  if (!revisedQuote) return null;
  const revision = job.revisions.find(
    (item) => item.quoteId === revisedQuote.id,
  );
  if (!revision) return null;
  const originalMaterial = snapshot(revision.originalTotals);
  const revisedMaterial = snapshot(revision.revisedTotals);
  if (!originalMaterial || !revisedMaterial) return null;

  const previous = quotes.filter(
    (quote) => quote.version < revisedQuote.version,
  );
  // Un intento rechazado o pendiente nunca sustituye al precio aceptado.
  const originalQuote =
    previous.find(
      (quote) =>
        (quote.status === 'APPROVED' || quote.status === 'SUPERSEDED') &&
        quote.approvedAt,
    ) ??
    [...previous]
      .reverse()
      .find(
        (quote) =>
          quote.status === 'SUPERSEDED' &&
          !quote.submittedAt &&
          !quote.approvedAt,
      ) ??
    null;
  const customer = job.estimate.dealerModeSnapshot === 'INTERNAL';

  const amounts = (material: MaterialSnapshot, quote: Quote | null) => {
    const estimate = { ...job.estimate, ...material };
    // El estado de la propuesta no cambia el importe que se está comparando.
    const discount = quote
      ? calculateEstimateDiscount(estimate, {
          status: 'REQUESTED',
          quotes: [{ ...quote, status: 'APPROVED' }],
          permit: job.permit,
        })
      : null;
    const materialSubtotal = money(
      discount?.material.subtotal ??
        (customer ? material.customerPriceT : material.priceT),
    );
    const materialTax = money(
      discount?.material.tax ??
        (customer ? material.customerTaxAmount : material.taxAmount),
    );
    const materialTotal = money(
      discount?.material.total ??
        (customer ? material.customerTotalPayable : material.totalPayable),
    );
    const installationTotal = quote
      ? money(discount?.installation.total ?? quote.total)
      : null;
    const permitFee = job.permit
      ? money(discount?.permit.total ?? job.permit.permitFeeSnapshot)
      : null;
    const cityFee =
      job.permit?.cityFee == null
        ? null
        : money(discount?.city.total ?? job.permit.cityFee);
    const projectTotal =
      installationTotal == null
        ? null
        : materialTotal
            .add(installationTotal)
            .add(permitFee ?? 0)
            .add(cityFee ?? 0);
    return {
      units: material.units,
      materialSubtotal: materialSubtotal.toFixed(2),
      materialTax: materialTax.toFixed(2),
      materialTotal: materialTotal.toFixed(2),
      installationTotal: installationTotal?.toFixed(2) ?? null,
      permitFee: permitFee?.toFixed(2) ?? null,
      cityFee: cityFee?.toFixed(2) ?? null,
      projectTotal: projectTotal?.toFixed(2) ?? null,
      discountApplied: Boolean(discount && money(discount.discount).gt(0)),
    };
  };

  const original = amounts(originalMaterial, originalQuote);
  const revised = amounts(revisedMaterial, revisedQuote);
  return {
    revisionId: revision.id,
    originalQuoteId: originalQuote?.id ?? null,
    revisedQuoteId: revisedQuote.id,
    accountCost: job.estimate.dealerModeSnapshot === 'EXTERNAL',
    includesPermit: Boolean(job.permit),
    cityFeePending: Boolean(job.permit && job.permit.cityFee == null),
    original,
    revised,
    difference:
      original.projectTotal == null || revised.projectTotal == null
        ? null
        : money(revised.projectTotal).sub(original.projectTotal).toFixed(2),
  };
}

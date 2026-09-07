import Decimal from 'decimal.js';

export type EstimateDiscountScope = 'MATERIAL' | 'INSTALLATION';
export type EstimateDiscountType = 'PERCENTAGE' | 'AMOUNT';
export type DiscountBucketKey = 'material' | 'installation' | 'permit' | 'city';
export type EstimateDiscountConfig = {
  // PROJECT se conserva únicamente para leer acuerdos anteriores.
  scope: EstimateDiscountScope | 'PROJECT';
  type: EstimateDiscountType;
  value: string;
  updatedById?: number;
  updatedAt?: string;
  lockedAt?: string;
  allocations?: Record<DiscountBucketKey, string>;
  checkoutAllocations?: Record<DiscountBucketKey, string>;
  materialDiscountBasis?: 'BEFORE_TAX';
  checkoutMaterialNetDiscount?: string;
  materialNetDiscount?: string;
};
export type DiscountBucket = {
  before: string;
  // En materiales incluye el ajuste fiscal; netDiscount es el descuento comercial.
  discount: string;
  total: string;
};
export type EstimateDiscountSummary = {
  scope: EstimateDiscountConfig['scope'];
  type: EstimateDiscountType;
  value: string;
  lockedAt: string | null;
  payer: 'CUSTOMER' | 'ACCOUNT_OWNER';
  base: string;
  // El descuento comercial de materiales no incluye la reducción del impuesto.
  discount: string;
  projectBefore: string;
  projectTotal: string;
  materialDiscountBasis?: 'BEFORE_TAX';
  material: DiscountBucket & {
    subtotal: string;
    tax: string;
    netDiscount: string;
  };
  installation: DiscountBucket;
  permit: DiscountBucket;
  city: DiscountBucket;
};

type Money = { toString(): string } | string | number | null | undefined;
type DiscountEstimate = {
  manualDiscount?: unknown;
  dealerModeSnapshot?: string | null;
  priceT?: Money;
  totalPayable?: Money;
  taxRate?: Money;
  customerPriceT?: Money;
  customerTotalPayable?: Money;
  customerTaxRate?: Money;
  payments?: { status?: string }[];
  installationJob?: DiscountInstallation | null;
};
type DiscountInstallation = {
  status?: string;
  quotes?: { status?: string; total: Money }[];
  permit?: { permitFeeSnapshot?: Money; cityFee?: Money } | null;
};
const money = (value: Money) =>
  new Decimal(value?.toString() ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const keys: DiscountBucketKey[] = [
  'material',
  'installation',
  'permit',
  'city',
];

export function hasDiscountableInstallation(
  installation: DiscountInstallation | null | undefined,
): boolean {
  if (!installation || installation.status === 'CANCELED') return false;
  const quote = installation.quotes?.find((q) => q.status !== 'REJECTED');
  return money(quote?.total).gt(0);
}

export function estimateDiscountConfig(
  value: unknown,
): EstimateDiscountConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as EstimateDiscountConfig;
  if (
    !['PROJECT', 'MATERIAL', 'INSTALLATION'].includes(config.scope) ||
    !['PERCENTAGE', 'AMOUNT'].includes(config.type)
  )
    return null;
  try {
    const amount = new Decimal(config.value);
    if (
      !amount.isFinite() ||
      amount.lte(0) ||
      (config.type === 'PERCENTAGE' && amount.gt(100))
    )
      return null;
  } catch {
    return null;
  }
  return config;
}

// El descuento de materiales se aplica después de promociones y antes del impuesto.
// Las piezas y las cotizaciones de instalación conservan sus precios originales.
export function calculateEstimateDiscount(
  estimate: DiscountEstimate,
  installation:
    | DiscountInstallation
    | null
    | undefined = estimate.installationJob,
): EstimateDiscountSummary | null {
  const config = estimateDiscountConfig(estimate.manualDiscount);
  if (!config) return null;
  if (
    config.scope === 'INSTALLATION' &&
    !hasDiscountableInstallation(installation)
  )
    return null;
  const customer = estimate.dealerModeSnapshot === 'INTERNAL';
  const job = installation?.status === 'CANCELED' ? null : installation;
  const quote = job?.quotes?.find((q) => q.status !== 'REJECTED');
  const amounts = {
    material: money(
      customer ? estimate.customerTotalPayable : estimate.totalPayable,
    ),
    installation: money(quote?.total),
    permit: money(job?.permit?.permitFeeSnapshot),
    city: money(job?.permit?.cityFee),
  };
  const oldSubtotal = money(
    customer ? estimate.customerPriceT : estimate.priceT,
  );
  const taxRate = new Decimal(
    (customer ? estimate.customerTaxRate : estimate.taxRate)?.toString() ?? 0,
  );
  const protectedPayment = estimate.payments?.some((payment) =>
    ['PENDING', 'PAID', 'REFUNDED'].includes(payment.status ?? ''),
  );
  // Mantiene los importes de acuerdos y checkouts anteriores a esta corrección.
  const legacyMaterialTerms =
    config.materialDiscountBasis !== 'BEFORE_TAX' &&
    (config.lockedAt ||
      (config.checkoutAllocations &&
        (estimate.payments === undefined || protectedPayment)));
  const materialBeforeTax = config.scope === 'MATERIAL' && !legacyMaterialTerms;
  const eligible: DiscountBucketKey[] =
    config.scope === 'PROJECT'
      ? keys
      : config.scope === 'MATERIAL'
        ? ['material']
        : ['installation'];
  const base = materialBeforeTax
    ? oldSubtotal
    : eligible.reduce((sum, k) => sum.add(amounts[k]), new Decimal(0));
  const requested =
    config.type === 'PERCENTAGE'
      ? base
          .mul(config.value)
          .div(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : money(config.value);
  const target = Decimal.min(requested, base);
  const shares: Record<DiscountBucketKey, Decimal> = {
    material: new Decimal(0),
    installation: new Decimal(0),
    permit: new Decimal(0),
    city: new Decimal(0),
  };
  let discountedMaterialSubtotal: Decimal | undefined;
  if (materialBeforeTax) {
    const agreedNetDiscount = config.lockedAt
      ? config.materialNetDiscount
      : protectedPayment
        ? config.checkoutMaterialNetDiscount
        : undefined;
    const netDiscount = Decimal.min(
      base,
      agreedNetDiscount === undefined ? target : money(agreedNetDiscount),
    );
    discountedMaterialSubtotal = oldSubtotal.sub(netDiscount);
    const tax = money(discountedMaterialSubtotal.mul(taxRate));
    // El ahorro fiscal no se presenta como parte del descuento comercial.
    shares.material = amounts.material.sub(discountedMaterialSubtotal.add(tax));
  } else if (config.lockedAt && config.allocations) {
    // Después del primer pago se preserva el importe acordado de cada concepto.
    for (const key of eligible)
      shares[key] = Decimal.min(amounts[key], money(config.allocations[key]));
  } else if (config.scope !== 'PROJECT') {
    // Material e instalación reciben su descuento completo, sin prorrateo.
    shares[eligible[0]] = target;
  } else if (base.gt(0)) {
    // Compatibilidad con descuentos de proyecto guardados anteriormente.
    const fractions = eligible
      .map((key) => {
        const exact = target.mul(amounts[key]).div(base).mul(100);
        shares[key] = exact.floor().div(100);
        return { key, remainder: exact.sub(exact.floor()) };
      })
      .sort((a, b) => b.remainder.cmp(a.remainder));
    let remaining = target
      .sub(eligible.reduce((sum, k) => sum.add(shares[k]), new Decimal(0)))
      .mul(100)
      .toNumber();
    for (const { key } of fractions) {
      if (remaining-- <= 0) break;
      shares[key] = shares[key].add('0.01');
    }
  }
  const buckets = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        before: amounts[key].toFixed(2),
        discount: shares[key].toFixed(2),
        total: amounts[key].sub(shares[key]).toFixed(2),
      },
    ]),
  ) as Record<DiscountBucketKey, DiscountBucket>;
  const subtotal =
    discountedMaterialSubtotal ??
    (shares.material.gt(0)
      ? money(
          new Decimal(buckets.material.total).div(new Decimal(1).add(taxRate)),
        )
      : oldSubtotal);
  const projectBefore = keys.reduce(
    (sum, key) => sum.add(amounts[key]),
    new Decimal(0),
  );
  const totalReduction = keys.reduce(
    (sum, key) => sum.add(shares[key]),
    new Decimal(0),
  );
  return {
    scope: config.scope,
    type: config.type,
    value: config.value,
    lockedAt: config.lockedAt ?? null,
    payer: customer ? 'CUSTOMER' : 'ACCOUNT_OWNER',
    base: base.toFixed(2),
    discount: (materialBeforeTax
      ? oldSubtotal.sub(subtotal)
      : totalReduction
    ).toFixed(2),
    projectBefore: projectBefore.toFixed(2),
    projectTotal: projectBefore.sub(totalReduction).toFixed(2),
    ...(materialBeforeTax
      ? { materialDiscountBasis: 'BEFORE_TAX' as const }
      : {}),
    ...buckets,
    material: {
      ...buckets.material,
      subtotal: subtotal.toFixed(2),
      tax: new Decimal(buckets.material.total).sub(subtotal).toFixed(2),
      netDiscount: oldSubtotal.sub(subtotal).toFixed(2),
    },
  };
}

export function discountAllocations(summary: EstimateDiscountSummary) {
  return Object.fromEntries(
    keys.map((key) => [key, summary[key].discount]),
  ) as Record<DiscountBucketKey, string>;
}

// Permite comprobar saldos de instalación sin cambiar su cotización técnica.
export function discountedInstallationTotal(
  estimate: DiscountEstimate,
  job: DiscountInstallation,
) {
  return new Decimal(
    calculateEstimateDiscount(estimate, job)?.installation.total ??
      job.quotes?.find((q) => q.status !== 'REJECTED')?.total?.toString() ??
      0,
  );
}

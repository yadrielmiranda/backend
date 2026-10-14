import { BadRequestException } from '@nestjs/common';
import {
  DealerMode,
  EstimateCustomerChargeOrigin,
  EstimateCustomerChargePricingMode,
  EstimateCustomerChargeSource,
  Prisma,
} from '@prisma/client';
import { buildEstimateInstallationSummary, type EstimateInstallationReportSummary } from './reporting/estimate-installation-summary';
import { networkSnapshot } from '@/dealer-network/dealer-network';

export type CustomerChargeRecord = {
  id: number;
  origin: EstimateCustomerChargeOrigin;
  source: EstimateCustomerChargeSource;
  sourceKey: string | null;
  sourceRefId: number | null;
  description: string;
  pricingMode: EstimateCustomerChargePricingMode;
  pricingValue: Prisma.Decimal | string | number;
  usedInCustomerQuote?: boolean;
  systemAmountSnapshot: Prisma.Decimal | string | number | null;
  sortOrder: number;
};

export type EstimateClassification = {
  dealerNetworkSnapshot?: unknown;
  dealerModeSnapshot: DealerMode | null;
  status?: { name: string } | null;
  order?: { id: number } | null;
  payments?: Array<{ status?: string; paidAt?: Date | string | null }>;
  user: {
    dealerMode: DealerMode | null;
    role: { name: string };
  };
};

export type EstimateCustomerChargeSummaryLine = {
  id: number | null;
  origin: EstimateCustomerChargeOrigin;
  source: EstimateCustomerChargeSource;
  sourceKey: string | null;
  sourceRefId: number | null;
  description: string;
  systemAmount: string | null;
  customerAmount: string | null;
  pricingMode: EstimateCustomerChargePricingMode | null;
  pricingValue: string | null;
  usedInCustomerQuote: boolean;
  needsReview: boolean;
  sortOrder: number;
};

export type EstimateCustomerChargeSummary = {
  enabled: true;
  lines: EstimateCustomerChargeSummaryLine[];
  systemTotal: string;
  customerTotal: string;
  knownSystemMargin: string;
  dealerCreatedTotal: string;
  systemTotalIncomplete: boolean;
  customerTotalIncomplete: boolean;
};

type SystemSourceLine = {
  source: Exclude<
    EstimateCustomerChargeSource,
    typeof EstimateCustomerChargeSource.CUSTOM
  >;
  sourceKey: string;
  sourceRefId: number | null;
  description: string;
  systemAmount: number | null;
  sortOrder: number;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function moneyString(value: number) {
  return roundMoney(value).toFixed(2);
}

function sameMoney(left: unknown, right: unknown) {
  const leftValue = nullableNumber(left);
  const rightValue = nullableNumber(right);

  if (leftValue === null || rightValue === null) {
    return leftValue === rightValue;
  }

  return Math.abs(roundMoney(leftValue) - roundMoney(rightValue)) < 0.005;
}

export function systemCustomerChargeKey(
  source: EstimateCustomerChargeSource,
  sourceRefId?: number | null,
) {
  switch (source) {
    case EstimateCustomerChargeSource.INSTALLATION:
      return 'INSTALLATION';
    case EstimateCustomerChargeSource.INSTALLATION_SERVICE:
      if (!Number.isInteger(sourceRefId) || Number(sourceRefId) < 1) {
        throw new BadRequestException(
          'An installation service source requires a valid service ID.',
        );
      }
      return `SERVICE:${sourceRefId}`;
    case EstimateCustomerChargeSource.PERMIT:
      return 'PERMIT';
    case EstimateCustomerChargeSource.CITY_FEE:
      return 'CITY_FEE';
    default:
      throw new BadRequestException('Invalid system customer charge source.');
  }
}

export function customerChargeDealerMode(estimate: EstimateClassification): DealerMode | null {
  if (estimate.user?.role?.name !== 'dealer') return null;

  const network = networkSnapshot(estimate);
  if (network) return network.nodes.at(-1)!.mode;

  const isActive =
    estimate.status?.name === 'Active' && !Boolean(estimate.order) &&
    !estimate.payments?.some(payment => ['PENDING', 'PAID', 'REFUNDED'].includes(payment.status ?? '') || payment.paidAt != null);
  return isActive
    ? (estimate.user.dealerMode ??
      estimate.dealerModeSnapshot ??
      DealerMode.EXTERNAL)
    : (estimate.dealerModeSnapshot ??
      estimate.user.dealerMode ??
      DealerMode.EXTERNAL);

}

export function isExternalDealerEstimate(estimate: EstimateClassification) {
  return customerChargeDealerMode(estimate) === DealerMode.EXTERNAL;
}

export function isInternalDealerEstimate(estimate: EstimateClassification) {
  return customerChargeDealerMode(estimate) === DealerMode.INTERNAL;
}

export function buildSystemCustomerChargeSources(
  installation: EstimateInstallationReportSummary | null | undefined,
): SystemSourceLine[] {
  if (!installation) return [];

  const lines: SystemSourceLine[] = [
    {
      source: EstimateCustomerChargeSource.INSTALLATION,
      sourceKey: systemCustomerChargeKey(
        EstimateCustomerChargeSource.INSTALLATION,
      ),
      sourceRefId: null,
      description: 'Installation',
      systemAmount: nullableNumber(installation.installationAmount),
      sortOrder: 10,
    },
  ];

  installation.additionalServices.forEach((service, index) => {
    lines.push({
      source: EstimateCustomerChargeSource.INSTALLATION_SERVICE,
      sourceKey: systemCustomerChargeKey(
        EstimateCustomerChargeSource.INSTALLATION_SERVICE,
        service.serviceId,
      ),
      sourceRefId: service.serviceId,
      description: service.name,
      systemAmount: nullableNumber(service.amount),
      sortOrder: 100 + index,
    });
  });

  if (installation.permitIncluded) {
    lines.push(
      {
        source: EstimateCustomerChargeSource.PERMIT,
        sourceKey: systemCustomerChargeKey(EstimateCustomerChargeSource.PERMIT),
        sourceRefId: null,
        description: 'Permit Fee',
        systemAmount: nullableNumber(installation.permitFee),
        sortOrder: 900,
      },
      {
        source: EstimateCustomerChargeSource.CITY_FEE,
        sourceKey: systemCustomerChargeKey(
          EstimateCustomerChargeSource.CITY_FEE,
        ),
        sourceRefId: null,
        description: 'City Fee',
        systemAmount: nullableNumber(installation.cityFee),
        sortOrder: 910,
      },
    );
  }

  return lines;
}

function calculateCustomerAmount(
  systemAmount: number | null,
  override: CustomerChargeRecord | undefined,
) {
  if (
    !override ||
    override.pricingMode === EstimateCustomerChargePricingMode.SAME
  ) {
    return systemAmount;
  }

  const value = numberValue(override.pricingValue);
  if (override.pricingMode === EstimateCustomerChargePricingMode.FINAL) {
    return roundMoney(value);
  }

  if (systemAmount === null) return null;

  if (override.pricingMode === EstimateCustomerChargePricingMode.PERCENTAGE) {
    return roundMoney(systemAmount * (1 + value / 100));
  }

  return roundMoney(systemAmount + value);
}

export function buildEstimateCustomerChargeSummary(params: {
  estimate: EstimateClassification;
  installation: EstimateInstallationReportSummary | null | undefined;
  charges: CustomerChargeRecord[];
}): EstimateCustomerChargeSummary | null {
  const mode = customerChargeDealerMode(params.estimate);
  if (mode === null) return null;
  const internal = mode === DealerMode.INTERNAL;
  const charges = params.charges ?? [];

  const overridesByKey = new Map(
    charges
      .filter(
        (charge) =>
          charge.origin === EstimateCustomerChargeOrigin.SYSTEM &&
          Boolean(charge.sourceKey),
      )
      .map((charge) => [charge.sourceKey!, charge]),
  );

  const systemLines = buildSystemCustomerChargeSources(params.installation).map(
    (source): EstimateCustomerChargeSummaryLine => {
      const savedOverride = overridesByKey.get(source.sourceKey);
      // An account changing to internal terms cannot keep a previous external
      // exclusion or a final price that replaces the company's calculated base.
      const incompatibleOverride = internal && Boolean(savedOverride &&
        (savedOverride.pricingMode !== EstimateCustomerChargePricingMode.PERCENTAGE &&
          savedOverride.pricingMode !== EstimateCustomerChargePricingMode.AMOUNT ||
          numberValue(savedOverride.pricingValue) < 0));
      const override = incompatibleOverride ? undefined : savedOverride;
      const usedInCustomerQuote = internal || override?.usedInCustomerQuote !== false;
      const customerAmount = calculateCustomerAmount(
        source.systemAmount,
        override,
      );

      return {
        id: override?.id ?? null,
        origin: EstimateCustomerChargeOrigin.SYSTEM,
        source: source.source,
        sourceKey: source.sourceKey,
        sourceRefId: source.sourceRefId,
        description: source.description,
        systemAmount:
          source.systemAmount === null
            ? null
            : moneyString(source.systemAmount),
        customerAmount:
          customerAmount === null ? null : moneyString(customerAmount),
        pricingMode: override?.pricingMode ?? (internal ? EstimateCustomerChargePricingMode.AMOUNT : null),
        pricingValue: override
          ? Number(override.pricingValue).toFixed(4)
          : internal ? '0.0000' : null,
        usedInCustomerQuote,
        needsReview: Boolean(
          incompatibleOverride || (internal && savedOverride?.usedInCustomerQuote === false) || override &&
            override.pricingMode !== EstimateCustomerChargePricingMode.SAME &&
            !sameMoney(source.systemAmount, override.systemAmountSnapshot),
        ),
        sortOrder: source.sortOrder,
      };
    },
  );

  const dealerLines = charges
    .filter((charge) => charge.origin === EstimateCustomerChargeOrigin.DEALER)
    .map(
      (charge): EstimateCustomerChargeSummaryLine => ({
        id: charge.id,
        origin: EstimateCustomerChargeOrigin.DEALER,
        source: EstimateCustomerChargeSource.CUSTOM,
        sourceKey: null,
        sourceRefId: null,
        description: charge.description,
        systemAmount: null,
        customerAmount: moneyString(numberValue(charge.pricingValue)),
        pricingMode: EstimateCustomerChargePricingMode.FINAL,
        pricingValue: Number(charge.pricingValue).toFixed(4),
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: charge.sortOrder,
      }),
    );

  const lines = [...systemLines, ...dealerLines].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || (left.id ?? 0) - (right.id ?? 0),
  );
  const systemTotal = roundMoney(
    systemLines.reduce(
      (total, line) => total + numberValue(line.systemAmount),
      0,
    ),
  );
  const customerTotal = roundMoney(
    lines.reduce(
      (total, line) =>
        total +
        (line.usedInCustomerQuote ? numberValue(line.customerAmount) : 0),
      0,
    ),
  );
  const dealerCreatedTotal = roundMoney(
    dealerLines.reduce(
      (total, line) => total + numberValue(line.customerAmount),
      0,
    ),
  );
  const knownSystemMargin = roundMoney(
    systemLines.reduce((total, line) => {
      if (
        line.systemAmount === null ||
        (line.usedInCustomerQuote && line.customerAmount === null)
      ) {
        return total;
      }
      return (
        total +
        (line.usedInCustomerQuote ? numberValue(line.customerAmount) : 0) -
        numberValue(line.systemAmount)
      );
    }, 0),
  );

  return {
    enabled: true,
    lines,
    systemTotal: moneyString(systemTotal),
    customerTotal: moneyString(customerTotal),
    knownSystemMargin: moneyString(knownSystemMargin),
    dealerCreatedTotal: moneyString(dealerCreatedTotal),
    systemTotalIncomplete: systemLines.some(
      (line) => line.systemAmount === null,
    ),
    customerTotalIncomplete: systemLines.some(
      (line) => line.usedInCustomerQuote && line.customerAmount === null,
    ),
  };
}

// These are additions to the existing company buckets, never replacement
// prices. Custom charges stay separate so callers can choose their due date.
export function internalCustomerChargeAdditions(params: {
  estimate: EstimateClassification;
  installation: EstimateInstallationReportSummary | null | undefined;
  charges: CustomerChargeRecord[];
}) {
  const additions = { installation: 0, permit: 0, city: 0, custom: 0 };
  if (isInternalDealerEstimate(params.estimate)) {
    const summary = buildEstimateCustomerChargeSummary(params)!;
    for (const line of summary.lines) {
      if (line.origin === EstimateCustomerChargeOrigin.DEALER) {
        additions.custom += numberValue(line.customerAmount);
      } else if (line.systemAmount !== null && line.customerAmount !== null) {
        const bucket = line.source === EstimateCustomerChargeSource.PERMIT ? 'permit'
          : line.source === EstimateCustomerChargeSource.CITY_FEE ? 'city' : 'installation';
        additions[bucket] += Math.max(0, numberValue(line.customerAmount) - numberValue(line.systemAmount));
      }
    }
  }
  return {
    installation: moneyString(additions.installation),
    permit: moneyString(additions.permit),
    city: moneyString(additions.city),
    custom: moneyString(additions.custom),
  };
}

export function internalCustomerChargeAdditionsForEstimate(
  estimate: any,
  job = estimate.installationJob,
) {
  const charges = estimate.customerCharges ?? [];
  if (!charges.length || !isInternalDealerEstimate(estimate)) {
    return { installation: '0.00', permit: '0.00', city: '0.00', custom: '0.00' };
  }
  const installation = buildEstimateInstallationSummary(job ? {
    ...job,
    quotes: (job.quotes ?? []).map((quote: { lines?: unknown[] }) => ({ ...quote, lines: quote.lines ?? [] })),
  } : null);
  return internalCustomerChargeAdditions({ estimate, installation, charges });
}

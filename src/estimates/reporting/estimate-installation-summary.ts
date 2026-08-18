import {
  InstallationJobStatus,
  InstallationQuoteStatus,
  Prisma,
} from '@prisma/client';

export const estimateInstallationSummarySelect = {
  id: true,
  status: true,
  quotes: {
    where: {
      status: {
        not: InstallationQuoteStatus.REJECTED,
      },
    },
    orderBy: {
      version: 'desc' as const,
    },
    take: 1,
    select: {
      status: true,
      total: true,
      serviceMinimumsSnapshot: true,
      lines: {
        orderBy: [
          { sortOrder: 'asc' as const },
          { id: 'asc' as const },
        ],
        select: {
          serviceId: true,
          origin: true,
          serviceNameSnapshot: true,
          adjustedAmount: true,
        },
      },
    },
  },
  permit: {
    select: {
      permitFeeSnapshot: true,
      cityFee: true,
    },
  },
} satisfies Prisma.InstallationJobSelect;

type InstallationSummarySource = Prisma.InstallationJobGetPayload<{
  select: typeof estimateInstallationSummarySelect;
}>;

export type EstimateInstallationReportSummary = {
  status: InstallationJobStatus;
  quoteStatus: InstallationQuoteStatus | null;
  installationAmount: string | null;
  installationTotal: string | null;
  additionalServices: Array<{
    serviceId: number;
    name: string;
    amount: string;
  }>;
  permitIncluded: boolean;
  permitFee: string | null;
  cityFee: string | null;
};

type AdditionalServiceTotal = {
  serviceId: number;
  name: string;
  amount: number;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function moneyString(value: number) {
  return roundMoney(value).toFixed(2);
}

function additionalServiceTotals(
  quote: InstallationSummarySource['quotes'][number],
) {
  const automaticServiceIds = new Set(
    quote.lines
      .filter((line) => line.origin === 'AUTO')
      .map((line) => line.serviceId),
  );
  const grouped = new Map<number, AdditionalServiceTotal>();

  for (const line of quote.lines) {
    if (
      line.origin !== 'USER_SELECTED' &&
      line.origin !== 'FIELD_ADDED'
    ) {
      continue;
    }

    const amount = numberValue(line.adjustedAmount);
    const current = grouped.get(line.serviceId);

    if (current) {
      current.amount = roundMoney(current.amount + amount);
    } else {
      grouped.set(line.serviceId, {
        serviceId: line.serviceId,
        name: line.serviceNameSnapshot,
        amount: roundMoney(amount),
      });
    }
  }

  const minimums = Array.isArray(quote.serviceMinimumsSnapshot)
    ? quote.serviceMinimumsSnapshot
    : [];

  for (const rawMinimum of minimums) {
    if (
      !rawMinimum ||
      typeof rawMinimum !== 'object' ||
      Array.isArray(rawMinimum)
    ) {
      continue;
    }

    const minimum = rawMinimum as Record<string, unknown>;
    const serviceId = Number(minimum.serviceId);
    const current = grouped.get(serviceId);

    // A minimum that belongs only to a manually added service is part of that
    // named extra. Automatic/shared adjustments stay inside Installation.
    if (current && !automaticServiceIds.has(serviceId)) {
      current.amount = roundMoney(
        current.amount + numberValue(minimum.adjustment),
      );
    }
  }

  return Array.from(grouped.values());
}

export function buildEstimateInstallationSummary(
  job: InstallationSummarySource | null | undefined,
): EstimateInstallationReportSummary | null {
  if (!job || job.status === InstallationJobStatus.CANCELED) {
    return null;
  }

  const quote = job.quotes[0] ?? null;
  const extras = quote ? additionalServiceTotals(quote) : [];
  const additionalServicesTotal = roundMoney(
    extras.reduce((total, service) => total + service.amount, 0),
  );
  const installationTotal = quote ? numberValue(quote.total) : null;
  const installationAmount =
    installationTotal == null
      ? null
      : roundMoney(Math.max(0, installationTotal - additionalServicesTotal));

  return {
    status: job.status,
    quoteStatus: quote?.status ?? null,
    installationAmount:
      installationAmount == null ? null : moneyString(installationAmount),
    installationTotal:
      installationTotal == null ? null : moneyString(installationTotal),
    additionalServices: extras.map((service) => ({
      serviceId: service.serviceId,
      name: service.name,
      amount: moneyString(service.amount),
    })),
    permitIncluded: Boolean(job.permit),
    permitFee: job.permit
      ? moneyString(numberValue(job.permit.permitFeeSnapshot))
      : null,
    cityFee:
      job.permit?.cityFee == null
        ? null
        : moneyString(numberValue(job.permit.cityFee)),
  };
}

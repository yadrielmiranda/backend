import { synchronizeScheduleChanges, refreshScheduledInstallation } from '@/payment-plans/payment-schedule';
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { BrandingType, Prisma } from '@prisma/client';
import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import { estimateInstallationSummarySelect } from '@/estimates/reporting/estimate-installation-summary';
import { attachEstimatePieceDiagramMetadata } from '@/estimates/reporting/estimate-piece-diagram-metadata';

export type AgreementPricingMode = 'detailed' | 'total';

export const agreementEstimateInclude = {
  user: { include: { role: true } },
  status: true,
  order: true,
  payments: { select: { status: true } },
  installationJob: { select: estimateInstallationSummarySelect },
  customerCharges: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  pieces: {
    orderBy: { id: 'asc' },
    include: {
      prod: true,
      bran: true,
      syst: true,
      conf: true,
      fColor: true,
      cryst: true,
      tin: true,
      coat: true,
      privacyOption: true,
      activeOption: true,
      preparationOption: true,
      sillOption: true,
      reinforcementOption: true,
      pieceMuntin: {
        include: {
          pattern: true,
          type: true,
          panels: { orderBy: { panelIndex: 'asc' } },
        },
      },
    },
  },
} satisfies Prisma.EstimateInclude;

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const pick = (source: any, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
const money = (value: unknown) =>
  value == null ? null : Number(value).toFixed(2);
const amountKeys = [
  'customerPriceT',
  'customerTaxAmount',
  'customerTotalPayable',
  'originalCustomerPriceT',
  'customerDiscountAmount',
];
const dimensionKeys = [
  'width',
  'height',
  'heightLeft',
  'heightRight',
  'legHeight',
  'sashHeight',
  'windowHeight',
  'doorWidth',
  'doorHeight',
  'leftSideliteWidth',
  'rightSideliteWidth',
  'leftPanels',
  'rightPanels',
  'panelCount',
  'highBottomPercent',
  'dpPosPsf',
  'dpNegPsf',
];
const selectionKeys = [
  'idProd',
  'idBrand',
  'idSyst',
  'idConf',
  'idFC',
  'idCryst',
  'idTint',
  'idCoat',
  'idPrivacy',
];

// Solo datos contratados. Mark, costos, ganancias, pagos y estados operativos no forman parte de la huella.
export function agreementContent(publicEstimate: any) {
  const discount = publicEstimate.manualDiscountSummary;
  const installation = publicEstimate.installationSummary;
  const charges = publicEstimate.customerChargesSummary;
  return {
    schema: 1,
    ...(publicEstimate.paymentPlanTerms ? { paymentPlan: publicEstimate.paymentPlanTerms } : {}),
    header: pick(publicEstimate, [
      'id',
      'number',
      'name',
      'date',
      'expiresAt',
      'customerFirstName',
      'customerLastName',
      'customerEmail',
      'customerPhone',
      'customerStreet',
      'customerCity',
      'customerState',
      'customerPostalCode',
    ]),
    totals: {
      ...Object.fromEntries(
        amountKeys.map((key) => [key, money(publicEstimate[key])]),
      ),
      customerTaxRate: Number(publicEstimate.customerTaxRate ?? 0).toFixed(4),
    },
    discount: discount
      ? {
          ...pick(discount, [
            'scope',
            'type',
            'value',
            'base',
            'discount',
            'projectBefore',
            'projectTotal',
          ]),
          material: discount.material,
          installation: discount.installation,
          permit: discount.permit,
          city: discount.city,
        }
      : null,
    installation: installation
      ? {
          ...pick(installation, [
            'installationAmount',
            'installationTotal',
            'permitIncluded',
            'permitFee',
            'cityFee',
          ]),
          additionalServices: installation.additionalServices,
        }
      : null,
    charges: charges
      ? {
          total: charges.customerTotal,
          incomplete: charges.customerTotalIncomplete,
          lines: charges.lines.map((line: any) =>
            pick(line, [
              'description',
              'customerAmount',
              'usedInCustomerQuote',
            ]),
          ),
        }
      : null,
    pieces: (publicEstimate.pieces ?? []).map((piece: any) => ({
      qty: piece.qty,
      ...pick(piece, selectionKeys),
      ...Object.fromEntries(
        dimensionKeys.map((key) => [
          key,
          piece[key] == null ? null : Number(piece[key]),
        ]),
      ),
      horizontalHeights: piece.horizontalHeights,
      screen: Boolean(piece.screen),
      highBottom: Boolean(piece.highBottom),
      options: [
        'activeOption',
        'preparationOption',
        'sillOption',
        'reinforcementOption',
      ].map((key) => piece[key]?.id ?? null),
      customerPrice: money(piece.customerPrice),
      customerSubtotal: money(piece.customerSubtotal),
      regularCustomerPrice: money(piece.regularCustomerPrice),
      muntin: piece.pieceMuntin
        ? {
            patternId: piece.pieceMuntin.patternId,
            typeId: piece.pieceMuntin.typeId,
            totalLites: piece.pieceMuntin.totalLites,
            panels: piece.pieceMuntin.panels.map((panel: any) =>
              pick(panel, [
                'panelIndex',
                'panelCode',
                'horizontalLites',
                'verticalLites',
              ]),
            ),
          }
        : null,
    })),
  };
}

export type AgreementCharge = {
  key: string;
  description: string;
  amount: string | null;
};
export type AgreementCharges = {
  lines: AgreementCharge[];
  total: string;
  materialTotal: string;
  projectTotal: string;
  incomplete: boolean;
};
export type AgreementScopes = {
  materialHash: string;
  charges: AgreementCharges;
};
export type ChangeOrderSummary = {
  number: number;
  baseAgreementId: string;
  baseRevision: number;
  previousTotal: string;
  newTotal: string;
  difference: string;
  previousIncomplete: boolean;
  newIncomplete: boolean;
  changedCharges: string[];
  items: Array<{
    description: string;
    before: AgreementCharge | null;
    after: AgreementCharge | null;
  }>;
};

// Se comparan exclusivamente los productos y cargos publicados al cliente.
// Un costo absorbido u ocultado por el dealer externo no altera su acuerdo.
export function agreementScopes(snapshot: any): AgreementScopes {
  const original = agreementContent(snapshot);
  const discount = snapshot.manualDiscountSummary;
  const materialTotal = money(
    discount?.material?.total ?? snapshot.customerTotalPayable ?? 0,
  )!;
  const materialHash = sha256(
    canonicalJson({
      ...(original.paymentPlan ? { paymentPlan: original.paymentPlan } : {}),
      header: original.header,
      totals: original.totals,
      materialDiscount: money(discount?.material?.discount ?? 0),
      materialTotal,
      pieces: original.pieces,
    }),
  );
  const raw: Array<{ description: string; amount: string | null }> = [];
  const add = (description: string, amount: unknown) =>
    raw.push({ description: description.trim(), amount: money(amount) });
  if (snapshot.customerChargesSummary) {
    for (const line of snapshot.customerChargesSummary.lines ?? []) {
      if (line.usedInCustomerQuote !== false)
        add(line.description, line.customerAmount);
    }
  } else if (snapshot.installationSummary) {
    const installation = snapshot.installationSummary;
    add('Installation', installation.installationAmount);
    for (const service of installation.additionalServices ?? [])
      add(service.name, service.amount);
    if (installation.permitIncluded) {
      add('Permit Fee', installation.permitFee);
      add('City Fee', installation.cityFee);
    }
    for (const [key, label] of [
      ['installation', 'Installation discount'],
      ['permit', 'Permit Fee discount'],
      ['city', 'City Fee discount'],
    ]) {
      const amount = Number(discount?.[key]?.discount ?? 0);
      if (amount > 0) add(label, -amount);
    }
  }
  // Ordenar la presentación no genera un anexo. Los nombres repetidos conservan todas sus líneas.
  raw.sort(
    (a, b) =>
      a.description.localeCompare(b.description, 'en') ||
      String(a.amount).localeCompare(String(b.amount), 'en'),
  );
  const occurrences = new Map<string, number>();
  const lines = raw.map((line) => {
    const occurrence = (occurrences.get(line.description) ?? 0) + 1;
    occurrences.set(line.description, occurrence);
    return { ...line, key: `${line.description}:${occurrence}` };
  });
  const total = lines.reduce(
    (sum, line) => sum.plus(line.amount ?? 0),
    new Decimal(0),
  );
  return {
    materialHash,
    charges: {
      lines,
      total: total.toFixed(2),
      materialTotal,
      projectTotal: total.plus(materialTotal).toFixed(2),
      incomplete: lines.some((line) => line.amount === null),
    },
  };
}

export function savedAgreementScopes(agreement: any): AgreementScopes | null {
  if (agreement.materialHash && agreement.chargesSnapshot)
    return {
      materialHash: agreement.materialHash,
      charges: agreement.chargesSnapshot,
    };
  // Las copias detalladas anteriores contienen los importes aceptados. Nunca se reescriben.
  if (agreement.snapshot && agreement.pricingMode === 'detailed')
    return agreementScopes(agreement.snapshot);
  return null;
}

export async function agreementComparison(
  db: Prisma.TransactionClient,
  id: string,
) {
  const agreement = await db.estimateAgreement.findUnique({
    where: { id },
    select: {
      id: true,
      pricingMode: true,
      contentHash: true,
      materialHash: true,
      chargesSnapshot: true,
    },
  });
  if (!agreement) return null;
  if (!agreement.materialHash && agreement.pricingMode === 'detailed') {
    const legacy = await db.estimateAgreement.findUnique({
      where: { id },
      select: { snapshot: true },
    });
    return { ...agreement, snapshot: legacy?.snapshot };
  }
  return agreement;
}

export function agreementMatches(
  agreement: any,
  current: {
    materialHash: string;
    charges: AgreementCharges;
    legacyContentHash: string;
  } | null,
) {
  if (!agreement || !current) return false;
  const saved = savedAgreementScopes(agreement);
  return saved
    ? saved.materialHash === current.materialHash &&
        canonicalJson(saved.charges) === canonicalJson(current.charges)
    : agreement.contentHash === current.legacyContentHash;
}

export function buildChangeOrder(
  base: { id: string; revision: number },
  previous: AgreementCharges,
  current: AgreementCharges,
  number: number,
  mode: AgreementPricingMode,
): ChangeOrderSummary {
  const before = new Map(previous.lines.map((line) => [line.key, line]));
  const after = new Map(current.lines.map((line) => [line.key, line]));
  const items = [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (key) => canonicalJson(before.get(key)) !== canonicalJson(after.get(key)),
    )
    .map((key) => ({
      description: (after.get(key) ?? before.get(key))!.description,
      before: before.get(key) ?? null,
      after: after.get(key) ?? null,
    }));
  return {
    number,
    baseAgreementId: base.id,
    baseRevision: base.revision,
    previousTotal: previous.projectTotal,
    newTotal: current.projectTotal,
    difference: new Decimal(current.projectTotal)
      .minus(previous.projectTotal)
      .toFixed(2),
    previousIncomplete: previous.incomplete,
    newIncomplete: current.incomplete,
    changedCharges: [...new Set(items.map((item) => item.description))],
    // La vista Project Total conserva su privacidad: muestra el ajuste total, sin desglose.
    items: mode === 'total' ? [] : items,
  };
}

export async function loadAgreementContent(
  db: Prisma.TransactionClient,
  estimateId: number,
  pricingMode: AgreementPricingMode,
  withSnapshot = false,
) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    include: agreementEstimateInclude,
  });
  if (!estimate) return null;
  // Se comparan los precios del cliente en ambas vistas, sin divulgar el desglose de la vista total.
  const detailed = buildPublicEstimateData(
    estimate,
    null,
    estimate.pieces,
    'detailed',
  );
  const legacyContentHash = sha256(
    canonicalJson(agreementContent(JSON.parse(JSON.stringify(detailed)))),
  );
  const scopes = agreementScopes(JSON.parse(JSON.stringify(detailed)));
  const contentHash = sha256(canonicalJson({ schema: 2, ...scopes }));
  if (!withSnapshot)
    return {
      estimate,
      contentHash,
      legacyContentHash,
      ...scopes,
      snapshot: null,
    };
  const dealerBranding = await db.branding.findFirst({
    where: {
      type: BrandingType.DEALER,
      userId: estimate.idUser,
      isActive: true,
    },
  });
  const branding =
    dealerBranding ??
    (await db.branding.findFirst({
      where: { type: BrandingType.COMPANY, isActive: true },
    }));
  const pieces = await attachEstimatePieceDiagramMetadata(
    db as any,
    estimate.pieces,
  );
  const snapshot = JSON.parse(
    JSON.stringify(
      buildPublicEstimateData(estimate, branding, pieces, pricingMode),
    ),
  );
  return { estimate, contentHash, legacyContentHash, ...scopes, snapshot };
}

// La invalidación es permanente: volver de A a B y luego a A no reactiva una aceptación anterior.
export async function invalidateChangedAgreements(
  db: Prisma.TransactionClient,
  estimateId: number,
) {
  const pending = await db.estimateAgreement.findMany({
    where: { estimateId, invalidatedAt: null },
    select: { id: true, contentHash: true },
  });
  if (!pending.length) return;
  const current = await loadAgreementContent(db, estimateId, 'detailed');
  const changedIds: string[] = [];
  for (const agreement of pending) {
    if (!agreementMatches(await agreementComparison(db, agreement.id), current))
      changedIds.push(agreement.id);
  }
  if (changedIds.length)
    await db.estimateAgreement.updateMany({
      where: { id: { in: changedIds }, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    });
}

// Todos los escritores del contenido contratado y el firmante utilizan el mismo bloqueo de Estimate.
export function withAgreementTransaction<T>(
  prisma: any,
  estimateId: number,
  work: (db: Prisma.TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  return prisma.$transaction(async (db: Prisma.TransactionClient) => {
    const locked = await db.$queryRaw<Array<{ id: number; paymentPlanSnapshot: unknown }>>`SELECT id, paymentPlanSnapshot FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
    const result = await work(db);
    if (locked?.[0]?.paymentPlanSnapshot) {
      await synchronizeScheduleChanges(db, estimateId);
      await refreshScheduledInstallation(db, estimateId);
    }
    await invalidateChangedAgreements(db, estimateId);
    return result;
  }, options);
}

export const INSTALLATION_APPROVAL_CATALOG_SCHEMA = 'ae.product-approvals.v1';

export type ApprovalSystemIdentity = { name: string; brandName: string; productName: string };
export type InstallationApprovalResult =
  | { status: 'available'; url: string; approvalId: string; variant: 'LMI' | 'LMI + SMI' }
  | { status: 'not_found' | 'ambiguous' };
export type ProductApprovalResult =
  | {
    status: 'available'; approvalId: string; variant: 'LMI' | 'LMI + SMI';
    installationUrl?: string; evaluationUrl?: string; officialUrl?: string;
  }
  | { status: 'not_found' | 'ambiguous' };

type ApprovalDocument = { type: string; url: string };
export type InstallationApprovalRecord = {
  brand: string;
  series: string;
  product: string;
  variant: string;
  approvalId: string;
  status: string;
  archived?: boolean | null;
  eligibleForCurrentDocumentList: boolean;
  expiresDate?: string | null;
  installationUrl?: string | null;
  evaluationUrl?: string | null;
  officialUrl?: string | null;
  documents?: ApprovalDocument[];
};

const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const brands: Record<string, string> = {
  'ECO WINDOWS SYSTEMS': 'ECO WINDOW SYSTEMS',
  'ECO WINDOW SYSTEMS': 'ECO WINDOW SYSTEMS',
  'ECO NOVO SYSTEMS': 'ECO NOVO',
  'ECO NOVO': 'ECO NOVO',
};
const productAliases: Record<string, string> = {
  'SINGLE HUNG WINDOW': 'SINGLE HUNG',
  'HORIZONTAL ROLLING WINDOW': 'HORIZONTAL ROLLER',
  'BI-FOLD DOOR': 'BI-FOLD',
  'PIVOT DOOR': 'PUERTA PIVOT',
  'GARAGE DOOR': 'PUERTA SECCIONAL DE GARAJE',
};
// These three products are sold as Eco Novo locally but listed under ECO Window
// Systems in the approval catalog. Their equivalence was explicitly confirmed.
const confirmedCatalogAliases: Record<string, { brand: string; product: string }> = {
  'ECO NOVO|475|WINDOW WALL-STORE FRONT': { brand: 'ECO WINDOW SYSTEMS', product: 'STOREFRONT' },
  'ECO NOVO|870|GARAGE DOOR': { brand: 'ECO WINDOW SYSTEMS', product: 'PUERTA SECCIONAL DE GARAJE' },
  'ECO NOVO|875|GARAGE DOOR': { brand: 'ECO WINDOW SYSTEMS', product: 'PUERTA SECCIONAL DE GARAJE' },
};

function seriesKey(name: string): string | null {
  const text = normalized(name);
  // This suffix is an actual catalog name, not a general substring match.
  if (text === 'SERIE 900 BI-FOLD') return '900';
  return /^(?:(?:SERIE|SERIES)\s+)?([1-9]\d{0,5})$/.exec(text)?.[1] ?? null;
}

function productKey(product: string, brand: string, series: string): string {
  const name = normalized(product);
  if (name === 'FRENCH DOOR') {
    if (brand === 'ECO NOVO' && series === '675') return 'FRENCH DOOR Y SIDELITE';
    if (brand === 'ECO WINDOW SYSTEMS' && ['600', '650', '800', '810', '950'].includes(series))
      return 'PUERTA ABATIBLE HACIA AFUERA';
  }
  // These local categories are broad; the individual series and configurations
  // identify fixed/projected products. Never apply these aliases to other series.
  if (name === 'CASEMENT WINDOW') {
    const bySeries = brand === 'ECO WINDOW SYSTEMS'
      ? { '500': 'CASEMENT', '550': 'FIXED WINDOW', '560': 'AWNING' }
      : brand === 'ECO NOVO' ? { '575': 'CASEMENT', '585': 'AWNING', '595': 'FIXED CASEMENT' } : {};
    return bySeries[series] ?? name;
  }
  if (name === 'WINDOW WALL-STORE FRONT' && brand === 'ECO WINDOW SYSTEMS' && ['400', '450'].includes(series))
    return 'WINDOW WALL';
  return productAliases[name] ?? name;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function isoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// A malformed upstream catalog is unavailable, not evidence that a system lacks
// an approval. Pending/excluded/marketing blocks are deliberately not considered.
export function parseInstallationApprovalCatalog(value: unknown): InstallationApprovalRecord[] {
  if (!record(value) || value.schema !== INSTALLATION_APPROVAL_CATALOG_SCHEMA ||
    !Array.isArray(value.approvals) || value.approvals.length > 5000) throw new Error('Invalid approval catalog.');
  for (const item of value.approvals) {
    if (!record(item) || !['brand', 'series', 'product', 'variant', 'approvalId', 'status'].every(key => text(item[key])) ||
      typeof item.eligibleForCurrentDocumentList !== 'boolean' ||
      (item.archived !== undefined && typeof item.archived !== 'boolean' && item.archived !== null) ||
      (item.expiresDate != null && (typeof item.expiresDate !== 'string' || !isoDate(item.expiresDate))) ||
      ['installationUrl', 'evaluationUrl', 'officialUrl'].some(key =>
        item[key] != null && (typeof item[key] !== 'string' || item[key].length > 2048)) ||
      (item.documents !== undefined && (!Array.isArray(item.documents) || item.documents.length > 100 ||
        item.documents.some(document => !record(document) || !text(document.type, 100) || !text(document.url, 2048))))) {
      throw new Error('Invalid approval catalog record.');
    }
  }
  return value.approvals as InstallationApprovalRecord[];
}

const officialHosts = new Set(['floridabuilding.org', 'www.floridabuilding.org', 'miamidade.gov', 'www.miamidade.gov']);
export function officialInstallationPdf(value: string): string | null {
  return officialDocumentUrl(value, true);
}

export function officialApprovalUrl(value: string): string | null {
  return officialDocumentUrl(value, false);
}

function officialDocumentUrl(value: string, requirePdf: boolean): string | null {
  if (value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password ||
      url.port || (requirePdf && !/^\/.*\.pdf$/i.test(path)) || /[\u0000-\u001f\\]/.test(path)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function matchingApprovals(
  system: ApprovalSystemIdentity,
  records: InstallationApprovalRecord[],
  now: Date,
): Array<{ record: InstallationApprovalRecord; variant: 'LMI' | 'LMI + SMI' }> {
  const brand = brands[normalized(system.brandName)];
  const series = seriesKey(system.name);
  if (!brand || !series) return [];
  const alias = confirmedCatalogAliases[`${brand}|${series}|${normalized(system.productName)}`];
  const catalogBrand = alias?.brand ?? brand;
  const product = alias?.product ?? productKey(system.productName, brand, series);
  const today = localDate(now);
  const matches: ReturnType<typeof matchingApprovals> = [];
  for (const item of records) {
    if (brands[normalized(item.brand)] !== catalogBrand || seriesKey(item.series) !== series || normalized(item.product) !== product ||
      item.eligibleForCurrentDocumentList !== true || item.archived === true ||
      !['APPROVED', 'FILE APPROVED'].includes(normalized(item.status)) ||
      (item.expiresDate != null && item.expiresDate < today)) continue;
    const variant = normalized(item.variant).replace(/\s*\+\s*/g, ' + ');
    if (variant !== 'LMI' && variant !== 'LMI + SMI') continue;
    matches.push({ record: item, variant });
  }
  return matches;
}

function documentUrls(item: InstallationApprovalRecord, kind: 'installation' | 'evaluation' | 'official'): string[] {
  const direct = item[`${kind}Url`];
  return direct?.trim() ? [direct] : (item.documents ?? [])
    .filter(document => normalized(document.type) === kind.toUpperCase()).map(document => document.url);
}

function documentKey(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.href;
}

export function resolveInstallationApproval(
  system: ApprovalSystemIdentity,
  records: InstallationApprovalRecord[],
  now = new Date(),
): InstallationApprovalResult {
  const candidates: Array<{ url: string; approvalId: string; variant: 'LMI' | 'LMI + SMI' }> = [];
  for (const { record: item, variant } of matchingApprovals(system, records, now)) {
    // An explicit installation URL may be a complete NOA. Otherwise only a
    // document explicitly classified as installation is eligible.
    for (const candidate of documentUrls(item, 'installation')) {
      const url = officialInstallationPdf(candidate);
      if (url) candidates.push({ url, approvalId: item.approvalId, variant });
    }
  }
  const pdfs = new Map<string, typeof candidates>();
  for (const item of candidates) {
    const key = documentKey(item.url);
    pdfs.set(key, [...(pdfs.get(key) ?? []), item]);
  }
  if (pdfs.size === 0) return { status: 'not_found' };
  if (pdfs.size > 1) return { status: 'ambiguous' };
  // Multiple subproducts may refer to the same PDF. Choose stable metadata only
  // after proving that no competing PDF remains.
  const matches = [...pdfs.values()][0].sort((a, b) =>
    a.approvalId.localeCompare(b.approvalId) || a.variant.localeCompare(b.variant) || a.url.localeCompare(b.url));
  return { status: 'available', ...matches[0] };
}

// Resolve all document types together: a shared installation PDF does not prove
// that conflicting evaluations or official approval records are interchangeable.
export function resolveProductApproval(
  system: ApprovalSystemIdentity,
  records: InstallationApprovalRecord[],
  now = new Date(),
): ProductApprovalResult {
  const kinds = ['installation', 'evaluation', 'official'] as const;
  const links = { installation: new Map<string, string>(), evaluation: new Map<string, string>(), official: new Map<string, string>() };
  const candidates: Array<{
    approvalId: string; variant: 'LMI' | 'LMI + SMI'; kinds: Set<typeof kinds[number]>;
  }> = [];
  for (const { record: item, variant } of matchingApprovals(system, records, now)) {
    const presentKinds = new Set<typeof kinds[number]>();
    for (const kind of kinds) {
      for (const raw of documentUrls(item, kind)) {
        const url = kind === 'official' ? officialApprovalUrl(raw) : officialInstallationPdf(raw);
        if (!url) continue;
        presentKinds.add(kind);
        const key = documentKey(url);
        const existing = links[kind].get(key);
        // Stable presentation for www/fragment aliases of the same document.
        if (!existing || url.localeCompare(existing) < 0) links[kind].set(key, url);
      }
    }
    if (presentKinds.size) candidates.push({ approvalId: item.approvalId, variant, kinds: presentKinds });
  }
  if (kinds.some(kind => links[kind].size > 1)) return { status: 'ambiguous' };
  if (candidates.length === 0) return { status: 'not_found' };
  // Never build a synthetic approval by combining complementary documents from
  // separate records. At least one record must support every returned link.
  const complete = candidates.filter(item => kinds.every(kind => !links[kind].size || item.kinds.has(kind)));
  if (!complete.length) return { status: 'ambiguous' };
  complete.sort((a, b) => a.approvalId.localeCompare(b.approvalId) || a.variant.localeCompare(b.variant));
  const documents: { installationUrl?: string; evaluationUrl?: string; officialUrl?: string } = {};
  for (const kind of kinds) {
    if (links[kind].size) documents[`${kind}Url`] = [...links[kind].values()][0];
  }
  return { status: 'available', approvalId: complete[0].approvalId, variant: complete[0].variant, ...documents };
}

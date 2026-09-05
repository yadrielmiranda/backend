import { DealerMode, type Branding } from '@prisma/client';

import type { EstimateInstallationReportSummary } from '../reporting/estimate-installation-summary';
import type { EstimateWithRelations, PdfView } from '../estimates.service';
import {
  calculateMaterialFinancials,
  resolveMaterialSaleSubtotal,
} from '../../orders/order-material-financials';

type ReportKind =
  | 'client'
  | 'dealer-customer'
  | 'dealer-customer-total'
  | 'dealer'
  | 'admin';
type MaterialTotals = {
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
};
type PieceDiagramRenders = Readonly<Record<string, string>>;
type PieceReportDetails = {
  productName: string;
  systemLine: string;
  summaryLine: string;
  detailLines: string[];
};

const DEFAULT_BRANDING_COLOR = '#000000';

const normalizeBrandingColor = (value: unknown) => {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();

  return /^#[0-9A-F]{6}$/.test(normalized)
    ? normalized
    : DEFAULT_BRANDING_COLOR;
};

const readableTextColor = (backgroundColor: unknown) => {
  const color = normalizeBrandingColor(backgroundColor);
  const channels = [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;

  return whiteContrast >= blackContrast ? '#FFFFFF' : '#000000';
};

const estimateStatusBadgeClassName = (value: unknown) => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (normalized === 'active') return 'status-active';
  if (normalized === 'ordered') return 'status-ordered';
  if (normalized === 'expired') return 'status-expired';
  return 'status-default';
};

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const numberValue = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const formatMoney = (value: unknown) =>
  numberValue(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const estimatedMaterialProfitability = (
  estimate: EstimateWithRelations,
  ownerIsDealer: boolean,
) => {
  const dealerMode = ownerIsDealer ? estimate.dealerModeSnapshot : null;
  const internalDealer = dealerMode === DealerMode.INTERNAL;
  const companyName = estimate.companyBranding?.name?.trim() || 'Company';
  const saleSubtotal = resolveMaterialSaleSubtotal({
    dealerMode,
    priceT: estimate.priceT,
    customerPriceT: estimate.customerPriceT,
  });
  const financials = calculateMaterialFinancials({
    saleSubtotal,
    factoryRate: estimate.rateT,
  });

  return {
    saleChannel: ownerIsDealer
      ? `${estimate.dealerModeSnapshot ?? 'EXTERNAL'} DEALER`
      : 'DIRECT CLIENT',
    profitLabel: `Estimated ${companyName} profit`,
    estimatedProfit: financials.totalProfit.toNumber(),
    calculationNote: internalDealer
      ? `Estimated ${companyName} profit uses customer material subtotal minus estimated factory rate.`
      : ownerIsDealer
        ? `Estimated ${companyName} profit uses dealer material subtotal minus estimated factory rate. The dealer's customer resale markup is excluded.`
        : `Estimated ${companyName} profit uses material sale subtotal minus estimated factory rate.`,
  };
};

const formatDate = (value: unknown) => {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

const formatInchesFromEighthStep = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '?';

  const sign = parsed < 0 ? '-' : '';
  const absolute = Math.abs(parsed);
  let whole = Math.floor(absolute);
  let eighths = Math.round((absolute - whole) * 8);

  if (eighths >= 8) {
    whole += 1;
    eighths = 0;
  }
  if (eighths === 0) return `${sign}${whole}`;

  const greatestCommonDivisor = (a: number, b: number): number =>
    b ? greatestCommonDivisor(b, a % b) : a;
  const divisor = greatestCommonDivisor(eighths, 8);
  const numerator = eighths / divisor;
  const denominator = 8 / divisor;

  return whole > 0
    ? `${sign}${whole} ${numerator}/${denominator}`
    : `${sign}${numerator}/${denominator}`;
};

const formatPsf = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(1)}`;
};

const optionName = (value: unknown) => {
  if (!value || typeof value !== 'object') return null;
  const option = value as Record<string, unknown>;
  const candidate = option.name ?? option.label;

  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : null;
};

const buildGridLine = (piece: any) => {
  const muntin = piece.pieceMuntin ?? piece.muntin ?? null;
  if (!muntin) return 'Grid: None';

  const patternName = [
    muntin.pattern?.name,
    muntin.patternName,
    muntin.name,
    piece.muntinPattern?.name,
    piece.pattern?.name,
  ].find((value) => typeof value === 'string' && value.trim());
  const panels = Array.isArray(muntin.panels) ? muntin.panels : [];

  if (!patternName) return 'Grid: Yes';
  if (panels.length === 0) return `Grid: ${patternName}`;

  const panelDetails = panels
    .map((panel: any) => {
      const label =
        String(panel?.panelLabel ?? '').trim() ||
        String(panel?.panelCode ?? '').trim() ||
        `Panel ${panel?.panelIndex ?? ''}`.trim();
      const horizontalLites = numberValue(panel?.horizontalLites ?? 1);
      const verticalLites = numberValue(panel?.verticalLites ?? 1);

      return `${label} ${horizontalLites}x${verticalLites}`;
    })
    .join(' | ');

  return `Grid: ${patternName} - ${panelDetails}`;
};

const optionalDimension = (value: unknown) =>
  value == null || value === '' ? null : formatInchesFromEighthStep(value);

const buildSizeLabel = (piece: any) => {
  const width = optionalDimension(piece.width);
  const height = optionalDimension(piece.height);

  if (width && height) return `${width} x ${height} in`;
  if (width) return `${width} in`;
  if (height) return `${height} in`;
  return 'Not specified';
};

const buildSpecialDimensionLines = (piece: any) => {
  const lines: string[] = [];
  const dimensionParts: string[] = [];
  const heightLeft = optionalDimension(piece.heightLeft);
  const heightRight = optionalDimension(piece.heightRight);
  const legHeight = optionalDimension(piece.legHeight);
  const sashHeight = optionalDimension(piece.sashHeight);
  const windowHeight = optionalDimension(piece.windowHeight);

  if (heightLeft) dimensionParts.push(`HL: ${heightLeft} in`);
  if (heightRight) dimensionParts.push(`HR: ${heightRight} in`);
  if (legHeight) dimensionParts.push(`Leg: ${legHeight} in`);
  if (sashHeight) dimensionParts.push(`Sash: ${sashHeight} in`);
  if (windowHeight) dimensionParts.push(`Window: ${windowHeight} in`);
  if (dimensionParts.length > 0) lines.push(dimensionParts.join(' | '));

  const doorWidth = optionalDimension(piece.doorWidth);
  const doorHeight = optionalDimension(piece.doorHeight);
  if (doorWidth || doorHeight) {
    lines.push(
      `Door: ${doorWidth ?? '?'}${doorHeight ? ` x ${doorHeight}` : ''} in`,
    );
  }

  const sideliteParts: string[] = [];
  const leftSideliteWidth = optionalDimension(piece.leftSideliteWidth);
  const rightSideliteWidth = optionalDimension(piece.rightSideliteWidth);
  if (leftSideliteWidth) {
    sideliteParts.push(`Left Sidelite: ${leftSideliteWidth} in`);
  }
  if (rightSideliteWidth) {
    sideliteParts.push(`Right Sidelite: ${rightSideliteWidth} in`);
  }
  if (sideliteParts.length > 0) lines.push(sideliteParts.join(' | '));

  const panelParts: string[] = [];
  if (piece.leftPanels != null) {
    panelParts.push(`Left Panels: ${piece.leftPanels}`);
  }
  if (piece.rightPanels != null) {
    panelParts.push(`Right Panels: ${piece.rightPanels}`);
  }
  if (piece.panelCount != null) panelParts.push(`Panels: ${piece.panelCount}`);
  if (panelParts.length > 0) lines.push(panelParts.join(' | '));

  if (
    Array.isArray(piece.horizontalHeights) &&
    piece.horizontalHeights.length > 0
  ) {
    lines.push(
      `Horizontal Heights: ${piece.horizontalHeights
        .map((value: unknown) => `${formatInchesFromEighthStep(value)} in`)
        .join(' | ')}`,
    );
  }

  return lines;
};

const buildPieceReportDetails = (piece: any): PieceReportDetails => {
  const active =
    optionName(piece.activeOption) ??
    optionName(piece.actOpt) ??
    optionName(piece.active);
  const preparation =
    optionName(piece.preparationOption) ??
    optionName(piece.prepOpt) ??
    optionName(piece.preparation);
  const sill = optionName(piece.sillOption) ?? optionName(piece.sill);
  const reinforcement =
    optionName(piece.reinforcementOption) ?? optionName(piece.reinforcement);
  const summaryParts = [
    piece.conf?.conf ? `Config: ${piece.conf.conf}` : null,
    `Size: ${buildSizeLabel(piece)}`,
    active ? `Active: ${active}` : null,
  ].filter((value): value is string => Boolean(value));
  const glass = [piece.cryst?.glass, piece.tin?.color, piece.coat?.name]
    .filter(
      (value) =>
        typeof value === 'string' &&
        Boolean(value.trim()) &&
        value.trim().toLowerCase() !== 'none',
    )
    .join(' + ');
  const detailLines = [
    `Frame Color: ${String(piece.fColor?.color ?? '').trim() || 'Not specified'}`,
  ];

  if (glass) detailLines.push(`Glass: ${glass}`);
  if (preparation) detailLines.push(`Preparation: ${preparation}`);
  if (sill) detailLines.push(`Sill: ${sill}`);
  if (reinforcement) detailLines.push(`Reinforcement: ${reinforcement}`);
  detailLines.push(...buildSpecialDimensionLines(piece));

  const optionParts = [
    `Screen: ${piece.screen ? 'Yes' : 'No'}`,
    buildGridLine(piece),
    `Privacy: ${piece.privacyOption?.name ?? 'None'}`,
  ];
  if (piece.highBottom) optionParts.push('High Bottom: Yes');
  detailLines.push(optionParts.join(' | '));

  if (piece.dpPosPsf != null && piece.dpNegPsf != null) {
    detailLines.push(
      `PSF: ${formatPsf(piece.dpPosPsf)} / ${formatPsf(piece.dpNegPsf)}`,
    );
  }

  return {
    productName: String(piece.prod?.name ?? '').trim() || 'Product',
    systemLine: [piece.bran?.name, piece.syst?.name]
      .filter(Boolean)
      .join(' - '),
    summaryLine: summaryParts.join(' | '),
    detailLines,
  };
};

const reportKindFor = (view: PdfView): ReportKind => {
  if (view === 'dealer_public') return 'dealer-customer';
  if (view === 'dealer_public_total') return 'dealer-customer-total';
  if (view === 'dealer_internal') return 'dealer';
  return view;
};

const reportLabelFor = (kind: ReportKind) => {
  if (kind === 'admin') return 'Admin Report';
  if (kind === 'dealer') return 'Dealer Report';
  return 'Customer Report';
};

const installationStatus = (summary: EstimateInstallationReportSummary) => {
  if (summary.status === 'DEPOSIT_PAYMENT_PENDING') {
    return { label: 'Proposed', className: 'badge-proposed' };
  }
  if (summary.quoteStatus === 'APPROVED') {
    return { label: 'Included', className: 'badge-included' };
  }
  return { label: 'Preliminary', className: 'badge-preliminary' };
};

const summaryRow = (
  label: string,
  value: string,
  options: { strong?: boolean; extraClass?: string } = {},
) => `
  <div class="summary-row${options.strong ? ' strong' : ''}${
    options.extraClass ? ` ${options.extraClass}` : ''
  }">
    <span>${escapeHtml(label)}</span>
    <span>${value}</span>
  </div>
`;

export class EstimatePdfHtmlBuilder {
  static buildFooterText(
    estimate: Pick<EstimateWithRelations, 'expiresAt'>,
  ): string {
    const expirationText = estimate.expiresAt
      ? `This estimate is valid through ${formatDate(estimate.expiresAt)}.`
      : 'This estimate is valid for 30 days.';

    return `${expirationText} Thank you for your business.`;
  }

  static build(
    estimate: EstimateWithRelations,
    view: PdfView,
    diagramRenders: PieceDiagramRenders = {},
  ): string {
    const reportKind = reportKindFor(view);
    const ownerIsDealer =
      String(estimate.user?.role?.name ?? '')
        .trim()
        .toLowerCase() === 'dealer';
    const projectTotalOnly = reportKind === 'dealer-customer-total';
    const customerFacing = reportKind === 'dealer-customer' || projectTotalOnly;
    const comparisonView =
      reportKind === 'dealer' || (reportKind === 'admin' && ownerIsDealer);
    const internalReport = reportKind === 'dealer' || reportKind === 'admin';
    const branding = (estimate.branding ?? null) as Branding | null;
    const brandingName = branding?.name?.trim() || '';
    const brandingColor = normalizeBrandingColor(branding?.brandingColor);
    const brandingContrastColor = readableTextColor(brandingColor);
    const brandingLocality = [branding?.city, branding?.state]
      .filter(Boolean)
      .join(', ');
    const brandingCityLine = [brandingLocality, branding?.postalCode]
      .filter(Boolean)
      .join(' ');
    const brandingAddress = [branding?.street, brandingCityLine]
      .filter(Boolean)
      .join(', ');
    const logo = branding?.logoUrl
      ? `<img class="brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="Logo" />`
      : '';

    const customerName = [estimate.customerFirstName, estimate.customerLastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const accountName = [estimate.user?.firstName, estimate.user?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const preparedFor =
      customerName ||
      (ownerIsDealer ? estimate.name : accountName || estimate.name);
    const projectName =
      estimate.name?.trim() && estimate.name.trim() !== preparedFor
        ? estimate.name.trim()
        : '';
    const contactEmail = ownerIsDealer
      ? estimate.customerEmail
      : estimate.customerEmail || estimate.user?.email;
    const contactPhone = ownerIsDealer
      ? estimate.customerPhone
      : estimate.customerPhone || estimate.user?.phone;
    const contactAddress = [
      estimate.customerStreet || (ownerIsDealer ? null : estimate.user?.street),
      estimate.customerCity || (ownerIsDealer ? null : estimate.user?.city),
      estimate.customerState || (ownerIsDealer ? null : estimate.user?.state),
      estimate.customerPostalCode ||
        (ownerIsDealer ? null : estimate.user?.postalCode),
    ]
      .filter(Boolean)
      .join(', ');

    const internalMaterial: MaterialTotals = {
      subtotal: numberValue(estimate.priceT),
      taxRate: numberValue(estimate.taxRate),
      taxAmount: numberValue(estimate.taxAmount),
      total: numberValue(estimate.totalPayable),
    };
    const customerMaterial: MaterialTotals = {
      subtotal: numberValue(estimate.customerPriceT),
      taxRate: numberValue(estimate.customerTaxRate),
      taxAmount: numberValue(estimate.customerTaxAmount),
      total: numberValue(estimate.customerTotalPayable),
    };
    const selectedMaterial = customerFacing
      ? customerMaterial
      : internalMaterial;
    const installationSummary = estimate.installationSummary ?? null;
    const externalDealerCharges = ownerIsDealer
      ? (estimate.customerChargesSummary ?? null)
      : null;
    const customerVisibleServiceLines =
      externalDealerCharges?.lines.filter((line) => line.usedInCustomerQuote) ??
      [];
    const installationTotal = numberValue(
      installationSummary?.installationTotal,
    );
    const permitFee = installationSummary?.permitIncluded
      ? numberValue(installationSummary.permitFee)
      : 0;
    const cityFee = numberValue(installationSummary?.cityFee);
    const sharedCharges = roundMoney(installationTotal + permitFee + cityFee);
    const customerServiceCharges = externalDealerCharges
      ? numberValue(externalDealerCharges.customerTotal)
      : sharedCharges;
    const internalProjectTotal = roundMoney(
      internalMaterial.total + sharedCharges,
    );
    const customerProjectTotal = roundMoney(
      customerMaterial.total + customerServiceCharges,
    );
    const selectedProjectTotal = roundMoney(
      selectedMaterial.total +
        (customerFacing ? customerServiceCharges : sharedCharges),
    );
    const cityFeePending = Boolean(
      installationSummary?.permitIncluded &&
        installationSummary.cityFee == null,
    );
    const installationAmountPending = Boolean(
      installationSummary && installationSummary.installationTotal == null,
    );
    const preliminaryInstallation = Boolean(
      installationSummary &&
        (installationSummary.quoteStatus !== 'APPROVED' ||
          installationSummary.status === 'DEPOSIT_PAYMENT_PENDING'),
    );
    const incompleteTotal = externalDealerCharges
      ? customerFacing
        ? externalDealerCharges.customerTotalIncomplete
        : externalDealerCharges.systemTotalIncomplete ||
          externalDealerCharges.customerTotalIncomplete
      : cityFeePending || installationAmountPending;

    const productCards = estimate.pieces.length
      ? estimate.pieces
          .map((piece: any, index: number) => {
            const displayMark =
              String(piece.mark ?? '').trim() || `#${index + 1}`;
            const unitPrice = customerFacing
              ? numberValue(piece.customerPrice)
              : numberValue(piece.price);
            const customerSubtotal =
              piece.customerSubtotal == null
                ? unitPrice * numberValue(piece.qty)
                : numberValue(piece.customerSubtotal);
            const subtotal = customerFacing
              ? customerSubtotal
              : numberValue(piece.subtotal);
            const details = buildPieceReportDetails(piece);
            const detailLines = details.detailLines
              .map(
                (line) => `<div class="piece-detail">${escapeHtml(line)}</div>`,
              )
              .join('');
            const diagramSrc =
              piece.id == null ? null : diagramRenders[String(piece.id)];
            const diagram = diagramSrc
              ? `<img src="${escapeHtml(diagramSrc)}" alt="Diagram for ${escapeHtml(displayMark)}" />`
              : '<div class="diagram-placeholder">Diagram unavailable</div>';
            const pricing = projectTotalOnly
              ? ''
              : `
                <div class="price-block">
                  <div class="price-label">Unit Price</div>
                  <div class="price-value">${formatMoney(unitPrice)}</div>
                </div>
                <div class="price-block subtotal-block price-success">
                  <div class="price-label">Subtotal</div>
                  <div class="price-value price-strong">${formatMoney(subtotal)}</div>
                </div>`;

            return `
              <article class="product-card">
                <div class="diagram-column"><div class="mark-badge">${escapeHtml(displayMark)}</div><div class="diagram-frame">${diagram}</div></div>
                <div class="piece-description">
                  <div class="piece-name">${escapeHtml(details.productName)}</div>
                  ${details.systemLine ? `<div class="piece-system">${escapeHtml(details.systemLine)}</div>` : ''}
                  <div class="piece-summary">${escapeHtml(details.summaryLine)}</div>
                  ${detailLines}
                </div>
                <div class="piece-pricing">
                  <div class="price-block">
                    <div class="price-label">Qty</div>
                    <div class="price-value">${escapeHtml(piece.qty)}</div>
                  </div>
                  ${pricing}
                </div>
              </article>`;
          })
          .join('')
      : '<div class="empty">No products included.</div>';

    const materialSummary = comparisonView
      ? `
        <div class="card keep-together">
          <table class="comparison-table">
            <thead><tr>
              <th>Material pricing</th>
              <th class="right">${reportKind === 'admin' ? 'Dealer Price' : 'Your Cost'}</th>
              <th class="right">Customer Price</th>
            </tr></thead>
            <tbody>
              <tr><td>Material subtotal</td><td class="right">${formatMoney(internalMaterial.subtotal)}</td><td class="right">${formatMoney(customerMaterial.subtotal)}</td></tr>
              <tr><td>Sales Tax</td><td class="right">${formatMoney(internalMaterial.taxAmount)}<small>${(internalMaterial.taxRate * 100).toFixed(2)}%</small></td><td class="right">${formatMoney(customerMaterial.taxAmount)}<small>${(customerMaterial.taxRate * 100).toFixed(2)}%</small></td></tr>
              <tr class="table-total"><td>Material total</td><td class="right">${formatMoney(internalMaterial.total)}</td><td class="right">${formatMoney(customerMaterial.total)}</td></tr>
            </tbody>
          </table>
        </div>`
      : `
        <div class="card keep-together">
          <div class="card-title">Materials</div>
          <div class="card-body">
            ${summaryRow('Material subtotal', formatMoney(selectedMaterial.subtotal))}
            ${summaryRow(`Sales Tax (${(selectedMaterial.taxRate * 100).toFixed(2)}%)`, formatMoney(selectedMaterial.taxAmount))}
            <div class="row-divider">${summaryRow('Material total', formatMoney(selectedMaterial.total), { strong: true })}</div>
          </div>
        </div>`;

    const installationSummaryHtml = (() => {
      if (externalDealerCharges) {
        const displayedLines = comparisonView
          ? externalDealerCharges.lines
          : customerVisibleServiceLines;

        if (displayedLines.length === 0) {
          return '';
        }

        if (comparisonView) {
          const rows = displayedLines
            .map(
              (line) => `
                <tr>
                  <td>${escapeHtml(line.description)}${line.origin === 'DEALER' ? '<small>Dealer-created</small>' : ''}</td>
                  <td class="right">${line.origin === 'DEALER' ? '&mdash;' : line.systemAmount == null ? 'Pending' : formatMoney(line.systemAmount)}</td>
                  <td class="right">${!line.usedInCustomerQuote ? 'Not used' : line.customerAmount == null ? 'Pending' : formatMoney(line.customerAmount)}</td>
                </tr>`,
            )
            .join('');

          return `
            <div class="card keep-together">
              <table class="comparison-table">
                <thead><tr><th>Installation &amp; services</th><th class="right">Dealer Cost</th><th class="right">Customer Price</th></tr></thead>
                <tbody>${rows}<tr class="table-total"><td>Services total</td><td class="right">${formatMoney(externalDealerCharges.systemTotal)}</td><td class="right">${formatMoney(externalDealerCharges.customerTotal)}</td></tr></tbody>
              </table>
            </div>`;
        }

        return `
          <div class="card keep-together">
            <div class="card-title">Installation &amp; services</div>
            <div class="card-body">${displayedLines
              .map((line) =>
                summaryRow(
                  line.description,
                  line.customerAmount == null
                    ? 'Pending'
                    : formatMoney(line.customerAmount),
                ),
              )
              .join('')}</div>
          </div>`;
      }

      if (!installationSummary) {
        return '';
      }

      const status = installationStatus(installationSummary);
      const installationValue =
        installationSummary.installationAmount == null
          ? 'Pending'
          : formatMoney(installationSummary.installationAmount);
      const rows = [
        summaryRow(
          'Installation',
          `<span class="value-with-badge"><span class="badge ${status.className}">${status.label}</span><span>${installationValue}</span></span>`,
        ),
      ];

      if (installationSummary.quoteStatus !== null) {
        if (installationSummary.additionalServices.length > 0) {
          for (const service of installationSummary.additionalServices) {
            rows.push(summaryRow(service.name, formatMoney(service.amount)));
          }
        } else {
          rows.push(summaryRow('Additional services', 'None included'));
        }

        if (installationSummary.permitIncluded) {
          rows.push(
            summaryRow(
              'Permit Fee',
              formatMoney(installationSummary.permitFee),
            ),
            summaryRow(
              'City Fee',
              installationSummary.cityFee == null
                ? 'Pending'
                : formatMoney(installationSummary.cityFee),
            ),
          );
        } else {
          rows.push(
            summaryRow('Permit service', 'Not included'),
            summaryRow('City Fee', 'Not applicable'),
          );
        }
      }

      return `
        <div class="card keep-together">
          <div class="card-title">Installation &amp; services</div>
          <div class="card-body">${rows.join('')}</div>
        </div>`;
    })();

    const projectScopeHtml = (() => {
      if (externalDealerCharges) {
        if (customerVisibleServiceLines.length === 0) return '';
        const rows = customerVisibleServiceLines
          .map((line) =>
            summaryRow(
              line.description,
              line.customerAmount == null ? 'Pending' : 'Included',
            ),
          )
          .join('');

        return `
          <div class="card keep-together">
            <div class="card-title">Project scope</div>
            <div class="card-body">${rows}</div>
          </div>`;
      }

      if (!installationSummary) {
        return '';
      }

      const status = installationStatus(installationSummary);
      const rows = [
        summaryRow(
          'Installation',
          `<span class="badge ${status.className}">${status.label}</span>`,
        ),
      ];

      if (installationSummary.quoteStatus !== null) {
        if (installationSummary.additionalServices.length > 0) {
          for (const service of installationSummary.additionalServices) {
            rows.push(summaryRow(service.name, 'Included'));
          }
        } else {
          rows.push(summaryRow('Additional services', 'None included'));
        }

        rows.push(
          summaryRow(
            'Permit service',
            installationSummary.permitIncluded ? 'Included' : 'Not included',
          ),
        );

        if (installationSummary.permitIncluded) {
          rows.push(
            summaryRow(
              'City Fee',
              installationSummary.cityFee == null ? 'Pending' : 'Included',
            ),
          );
        }
      }

      return `
        <div class="card keep-together">
          <div class="card-title">Project scope</div>
          <div class="card-body">${rows.join('')}</div>
        </div>`;
    })();

    const notices = `
      ${!externalDealerCharges && installationAmountPending ? '<p class="notice warning">Installation amount is pending.</p>' : ''}
      ${!externalDealerCharges && cityFeePending ? '<p class="notice warning">Final total is pending the City Fee.</p>' : ''}
      ${!externalDealerCharges && preliminaryInstallation && !installationAmountPending ? '<p class="notice">Installation is proposed and is not yet confirmed.</p>' : ''}
      ${externalDealerCharges?.customerTotalIncomplete && customerFacing ? '<p class="notice warning">Customer service pricing is incomplete.</p>' : ''}`;
    const projectTotalHtml = comparisonView
      ? `
        <div class="project-total keep-together">
          ${summaryRow(
            reportKind === 'dealer'
              ? incompleteTotal
                ? 'Your Current Project Cost'
                : 'Your Project Cost'
              : incompleteTotal
                ? 'Current Dealer Project Total'
                : 'Dealer Project Total',
            formatMoney(internalProjectTotal),
            { strong: true },
          )}
          ${summaryRow(incompleteTotal ? 'Current Customer Project Total' : 'Customer Project Total', formatMoney(customerProjectTotal), { strong: true })}
          ${
            reportKind === 'dealer'
              ? summaryRow(
                  'Dealer Profit - materials only, pre-tax',
                  formatMoney(
                    roundMoney(
                      customerMaterial.subtotal - internalMaterial.subtotal,
                    ),
                  ),
                  { extraClass: 'profit-row' },
                )
              : ''
          }
          ${notices}
        </div>`
      : `
        <div class="project-total project-total-success keep-together">
          ${summaryRow(incompleteTotal ? 'Current Project Total' : 'Project Total', formatMoney(selectedProjectTotal), { strong: true })}
          ${notices}
        </div>`;

    const profitability = estimatedMaterialProfitability(
      estimate,
      ownerIsDealer,
    );
    const adminProfitability =
      reportKind === 'admin'
        ? `
          <div class="card profitability keep-together">
            <div class="card-title"><strong>Estimated material profitability</strong><small>Admin only - materials only - before taxes - installation excluded</small></div>
            <div class="profit-grid">
              ${summaryRow('Sale channel', escapeHtml(profitability.saleChannel))}
              ${summaryRow('Estimated factory rate', formatMoney(estimate.rateT))}
              ${summaryRow(escapeHtml(profitability.profitLabel), formatMoney(profitability.estimatedProfit), { strong: true })}
            </div>
            <p class="profit-note">${escapeHtml(profitability.calculationNote)}</p>
          </div>`
        : '';
    const summaryGridClass =
      comparisonView || !installationSummaryHtml
        ? 'summary-grid single-column'
        : 'summary-grid';
    const projectSummaryHtml = projectTotalOnly
      ? `<div class="summary-start"><h2 class="section-heading">Project Summary</h2></div>${projectScopeHtml}${projectTotalHtml}<p class="illustration-footer">Product illustrations are visual references and are not to scale; written specifications govern.</p>`
      : `<div class="summary-start"><h2 class="section-heading">Project Summary</h2></div><div class="${summaryGridClass}">${materialSummary}${installationSummaryHtml}</div>${projectTotalHtml}${adminProfitability}<p class="illustration-footer">Product illustrations are visual references and are not to scale; written specifications govern.</p>`;

    const statusBadge = estimate.status?.name
      ? `<span class="status-badge ${estimateStatusBadgeClassName(estimate.status.name)}">${escapeHtml(estimate.status.name)}</span>`
      : '';
    const internalBadge = internalReport
      ? `<span class="internal-badge">Internal - ${escapeHtml(reportLabelFor(reportKind))}</span>`
      : '';
    return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Estimate ${escapeHtml(estimate.number)} - ${escapeHtml(reportLabelFor(reportKind))}</title>
  <style>
    :root { --branding-color: ${brandingColor}; --branding-contrast-color: ${brandingContrastColor}; --report-text-color: #000000; }
    @page { size: Letter portrait; margin: 12mm 12mm 18mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: var(--report-text-color); font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; orphans: 3; widows: 3; }
    .report { width: 100%; }
    .document-header { display: grid; grid-template-columns: 1fr 230px 1fr; align-items: start; gap: 18px; padding-bottom: 15px; border-bottom: 1px solid #dbe3ee; break-inside: avoid; page-break-inside: avoid; }
    h1 { margin: 0; color: var(--branding-color); font-size: 29px; font-weight: 800; letter-spacing: .08em; line-height: 1; text-transform: uppercase; }
    .number-label, .eyebrow, .date-label { color: var(--report-text-color); font-size: 8px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .number-label { margin-top: 11px; }
    .estimate-number-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-top: 2px; }
    .estimate-number { color: var(--branding-color); font-size: 18px; font-weight: 700; }
    .header-badges { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
    .status-badge, .internal-badge, .badge { display: inline-block; border-radius: 999px; padding: 3px 9px; font-size: 9px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
    .status-active { background: #dcfce7; color: #166534; }
    .status-ordered { background: #dbeafe; color: #1e40af; }
    .status-expired { background: #fee2e2; color: #991b1b; }
    .status-default { background: #f3f4f6; color: #1f2937; }
    .internal-badge { background: #0f172a; color: #fff; }
    .badge-not-included { border: 1px solid #f3c765; background: #fffbeb; color: #92400e; }
    .badge-included { border: 1px solid #6ee7b7; background: #ecfdf5; color: #047857; }
    .badge-proposed { border: 1px solid #93c5fd; background: #eff6ff; color: #1d4ed8; }
    .badge-preliminary { border: 1px solid #cbd5e1; background: #f8fafc; color: var(--report-text-color); }
    .logo-wrap { display: flex; align-items: center; justify-content: center; min-height: 112px; }
    .brand-logo { display: block; width: 230px; height: 112px; max-width: 100%; object-fit: contain; }
    .brand { text-align: right; color: var(--report-text-color); }
    .brand-name { color: var(--branding-color); font-size: 16px; font-weight: 700; }
    .brand-line { margin-top: 2px; font-size: 9px; }
    .prepared-section { display: grid; grid-template-columns: 1.05fr 1.45fr auto; align-items: center; gap: 20px; margin: 16px 0 18px; padding: 12px 14px; border: 1px solid #dbe3ee; border-radius: 9px; background: #f8fafc; break-inside: avoid; page-break-inside: avoid; }
    .prepared-name { margin-top: 4px; color: var(--branding-color); font-size: 15px; font-weight: 700; }
    .project-name { margin-top: 3px; color: var(--report-text-color); }
    .contact { color: var(--report-text-color); }
    .contact div { margin-top: 2px; }
    .dates { min-width: 150px; text-align: right; color: #0f172a; font-weight: 600; }
    .date-group + .date-group { margin-top: 8px; }
    .date-value { margin-top: 2px; color: var(--branding-color); }
    .section-heading { margin: 0 0 9px; color: #0f172a; font-size: 15px; font-weight: 800; letter-spacing: .035em; text-transform: uppercase; break-after: avoid; page-break-after: avoid; }
    .products-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 9px; break-after: avoid; page-break-after: avoid; }
    .products-heading .section-heading { margin: 0; }
    .illustration-note { color: var(--report-text-color); font-size: 8px; text-align: right; }
    table { width: 100%; border-spacing: 0; }
    .product-list { display: block; }
    .product-card { position: relative; display: grid; grid-template-columns: 190px minmax(0, 1fr) 180px; min-height: 202px; margin: 0 0 9px; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 9px; background: #fff; break-inside: avoid-page !important; page-break-inside: avoid !important; }
    .mark-badge { align-self: flex-start; min-width: 41px; margin-bottom: 2px; padding: 5px 10px; border-radius: 5px; background: var(--branding-color); color: var(--branding-contrast-color); font-size: 10px; font-weight: 700; line-height: 1.2; text-align: center; }
    .diagram-column { display: flex; flex-direction: column; align-items: stretch; padding: 8px; }
    .diagram-frame { display: flex; align-items: center; justify-content: center; width: 100%; height: 158px; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 7px; background: #f1f5f9; }
    .diagram-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .diagram-placeholder { color: var(--report-text-color); font-size: 8px; text-align: center; }
    .piece-description { min-width: 0; padding: 11px 12px; }
    .piece-name { color: #0f172a; font-size: 14px; font-weight: 700; line-height: 1.15; }
    .piece-system { margin-top: 4px; color: var(--branding-color); font-size: 10px; font-weight: 700; }
    .piece-summary { margin-top: 11px; color: #0f172a; font-size: 10px; font-weight: 700; }
    .piece-detail { margin-top: 3px; color: var(--report-text-color); font-size: 8.5px; line-height: 1.3; }
    .piece-pricing { display: flex; flex-direction: column; justify-content: space-between; gap: 0; padding: 12px 11px; border-left: 1px solid #dbe3ee; background: #fff; }
    .price-block { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .price-label { flex: 0 0 auto; color: var(--report-text-color); font-size: 8px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .price-value { color: #0f172a; font-size: 11px; font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; white-space: nowrap; }
    .subtotal-block { margin-top: 0; padding-top: 0; }
    .price-strong { font-size: 13px; font-weight: 700; }
    .price-success .price-label, .price-success .price-value { color: #07883f; }
    .price-success .price-strong { font-size: 17px; font-weight: 800; }
    .empty { padding: 28px; border: 1px dashed #cbd5e1; border-radius: 9px; color: var(--report-text-color); text-align: center; }
    .summary-section { margin-top: 22px; break-inside: avoid-page; page-break-inside: avoid; }
    .summary-start { break-inside: avoid; page-break-inside: avoid; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: start; gap: 10px; }
    .summary-grid.single-column { grid-template-columns: 1fr; }
    .card, .project-total { margin-top: 0; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 9px; background: #fff; }
    .keep-together { break-inside: avoid; page-break-inside: avoid; }
    .card-title { padding: 10px 13px; background: #f8fafc; color: #172033; font-size: 12px; font-weight: 700; }
    .card-title small { display: block; margin-top: 2px; color: var(--report-text-color); font-size: 8px; font-weight: 400; }
    .card-body { padding: 3px 13px; }
    .summary-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 7px 0; color: var(--report-text-color); }
    .summary-row > span:last-child { color: #172033; font-weight: 600; text-align: right; }
    .summary-row.strong { font-weight: 700; color: #172033; }
    .summary-row.strong > span:last-child { font-weight: 700; }
    .row-divider { border-top: 1px solid #dbe3ee; }
    .value-with-badge { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .comparison-table { border-collapse: separate; }
    .comparison-table th, .comparison-table td { padding: 9px 13px; }
    .comparison-table th { background: #f8fafc; color: var(--report-text-color); font-size: 9px; text-align: left; text-transform: uppercase; }
    .comparison-table td { border-top: 1px solid #e2e8f0; color: var(--report-text-color); }
    .comparison-table .right { text-align: right; color: #172033; font-weight: 600; }
    .comparison-table small { display: block; margin-top: 2px; color: var(--report-text-color); font-size: 8px; font-weight: 400; }
    .comparison-table .table-total td { background: #f8fafc; color: #172033; font-weight: 700; }
    .project-total { margin-top: 10px; padding: 6px 14px; border-color: #cbd5e1; background: #f1f5f9; }
    .project-total .summary-row.strong { font-size: 13px; }
    .project-total .summary-row.strong > span:last-child { font-size: 17px; }
    .project-total-success { padding: 16px 18px; border-color: #86efac; background: #ecfdf5; }
    .project-total-success .summary-row.strong > span:first-child { font-size: 16px; letter-spacing: .03em; text-transform: uppercase; }
    .project-total-success .summary-row.strong > span:last-child { color: #07883f; font-size: 25px; font-weight: 800; }
    .profit-row > span:last-child { color: #047857; }
    .notice { margin: 0 0 7px; color: #1e40af; font-size: 9px; }
    .notice.warning { color: #92400e; font-weight: 600; }
    .profitability { margin-top: 14px; }
    .profit-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 30px; padding: 3px 13px; }
    .profit-note { margin: 0; padding: 9px 13px; border-top: 1px solid #dbe3ee; color: var(--report-text-color); font-size: 8px; }
    .illustration-footer { margin: 14px 0 0; color: var(--report-text-color); font-size: 8px; }
  </style>
</head><body><main class="report">
  <header class="document-header">
    <div><h1>Estimate</h1><div class="number-label">Number</div><div class="estimate-number-row"><span class="estimate-number">${escapeHtml(estimate.number)}</span>${statusBadge}</div><div class="header-badges">${internalBadge}</div></div>
    <div class="logo-wrap">${logo}</div>
    <div class="brand">${brandingName ? `<div class="brand-name">${escapeHtml(brandingName)}</div>` : ''}${branding?.phone ? `<div class="brand-line">${escapeHtml(branding.phone)}</div>` : ''}${branding?.email ? `<div class="brand-line">${escapeHtml(branding.email)}</div>` : ''}${brandingAddress ? `<div class="brand-line">${escapeHtml(brandingAddress)}</div>` : ''}${branding?.website ? `<div class="brand-line">${escapeHtml(branding.website)}</div>` : ''}</div>
  </header>
  <section class="prepared-section">
    <div class="prepared-details"><div class="eyebrow">Prepared for</div><div class="prepared-name">${escapeHtml(preparedFor)}</div>${projectName ? `<div class="project-name">Project: ${escapeHtml(projectName)}</div>` : ''}</div>
    <div class="contact">${contactPhone ? `<div>${escapeHtml(contactPhone)}</div>` : ''}${contactEmail ? `<div>${escapeHtml(contactEmail)}</div>` : ''}${contactAddress ? `<div>${escapeHtml(contactAddress)}</div>` : ''}</div>
    <div class="dates"><div class="date-group"><div class="date-label">Date</div><div class="date-value">${escapeHtml(formatDate(estimate.date))}</div></div>${estimate.expiresAt ? `<div class="date-group"><div class="date-label">Valid through</div><div class="date-value">${escapeHtml(formatDate(estimate.expiresAt))}</div></div>` : ''}</div>
  </section>
  <section class="products-section"><div class="products-heading"><h2 class="section-heading">Product Details</h2><div class="illustration-note">Illustrations are visual references; written specifications govern.</div></div><div class="product-list">${productCards}</div></section>
  <section class="summary-section">${projectSummaryHtml}</section>
</main></body></html>`;
  }
}

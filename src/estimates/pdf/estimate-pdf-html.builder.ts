import type { Branding } from '@prisma/client';

import type { EstimateInstallationReportSummary } from '../reporting/estimate-installation-summary';
import type { EstimateWithRelations, PdfView } from '../estimates.service';

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

const buildPieceDescriptionLines = (piece: any) => {
  const header = [
    piece.prod?.name,
    piece.bran?.name,
    piece.syst?.name,
    piece.conf?.conf,
  ]
    .filter(Boolean)
    .join(' ');
  const width =
    piece.width == null ? '?' : formatInchesFromEighthStep(piece.width);
  const height =
    piece.height == null ? '?' : formatInchesFromEighthStep(piece.height);
  const sizeParts = [`${width} x ${height}`];

  if (piece.heightLeft != null) {
    sizeParts.push(`HL ${formatInchesFromEighthStep(piece.heightLeft)}`);
  }
  if (piece.heightRight != null) {
    sizeParts.push(`HR ${formatInchesFromEighthStep(piece.heightRight)}`);
  }
  if (piece.sashHeight != null) {
    sizeParts.push(`Sash ${formatInchesFromEighthStep(piece.sashHeight)}`);
  }
  if (piece.legHeight != null) {
    sizeParts.push(`Leg ${formatInchesFromEighthStep(piece.legHeight)}`);
  }

  const glass = [piece.cryst?.glass, piece.tin?.color, piece.coat?.name]
    .filter(Boolean)
    .join(' + ');
  const details: string[] = [];
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
    optionName(piece.reinforcementOption) ??
    optionName(piece.reinforcement);

  if (active) details.push(`Active: ${active}`);
  if (preparation) details.push(`Preparation: ${preparation}`);
  if (sill) details.push(`Sill: ${sill}`);
  if (reinforcement) details.push(`Reinforcement: ${reinforcement}`);
  details.push(`Screen: ${piece.screen ? 'Yes' : 'No'}`);
  if (piece.highBottom) details.push('High Bottom: Yes');
  details.push(buildGridLine(piece));
  details.push(`Privacy: ${piece.privacyOption?.name ?? 'None'}`);

  const psf =
    piece.dpPosPsf != null && piece.dpNegPsf != null
      ? `PSF: ${formatPsf(piece.dpPosPsf)} ${formatPsf(piece.dpNegPsf)}`
      : '';

  return [
    header,
    `Size: ${sizeParts.join(' / ')}`,
    glass ? `Glass: ${glass}` : '',
    ...details,
    psf,
  ].filter((line) => line.trim());
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
  static build(estimate: EstimateWithRelations, view: PdfView): string {
    const reportKind = reportKindFor(view);
    const ownerIsDealer =
      String(estimate.user?.role?.name ?? '').trim().toLowerCase() === 'dealer';
    const projectTotalOnly = reportKind === 'dealer-customer-total';
    const customerFacing =
      reportKind === 'dealer-customer' || projectTotalOnly;
    const comparisonView =
      reportKind === 'dealer' || (reportKind === 'admin' && ownerIsDealer);
    const internalReport = reportKind === 'dealer' || reportKind === 'admin';
    const branding = (estimate.branding ?? null) as Branding | null;
    const brandingName = branding?.name ?? 'Impact Plus';
    const brandingAddress = [
      branding?.street,
      branding?.city,
      branding?.state,
      branding?.postalCode,
    ]
      .filter(Boolean)
      .join(', ');
    const logo = branding?.logoUrl
      ? `<img class="brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="Logo" />`
      : '';

    const customerName = [
      estimate.customerFirstName,
      estimate.customerLastName,
    ]
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
    const selectedMaterial = customerFacing ? customerMaterial : internalMaterial;
    const installationSummary = estimate.installationSummary ?? null;
    const installationTotal = numberValue(
      installationSummary?.installationTotal,
    );
    const permitFee = installationSummary?.permitIncluded
      ? numberValue(installationSummary.permitFee)
      : 0;
    const cityFee = numberValue(installationSummary?.cityFee);
    const sharedCharges = roundMoney(installationTotal + permitFee + cityFee);
    const internalProjectTotal = roundMoney(
      internalMaterial.total + sharedCharges,
    );
    const customerProjectTotal = roundMoney(
      customerMaterial.total + sharedCharges,
    );
    const selectedProjectTotal = roundMoney(
      selectedMaterial.total + sharedCharges,
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
    const incompleteTotal = cityFeePending || installationAmountPending;

    const productRows = estimate.pieces.length
      ? estimate.pieces
          .map((piece: any) => {
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
            const description = buildPieceDescriptionLines(piece)
              .map(
                (line, index) =>
                  `<div class="${index === 0 ? 'piece-name' : 'piece-detail'}">${escapeHtml(line)}</div>`,
              )
              .join('');

            return `
              <tbody class="product-group">
                <tr class="product-row">
                  <td class="mark">${escapeHtml(piece.mark)}</td>
                  <td class="description">${description}</td>
                  <td class="center">${escapeHtml(piece.qty)}</td>
                  ${projectTotalOnly ? '' : `<td class="right">${formatMoney(unitPrice)}</td><td class="right strong-text">${formatMoney(subtotal)}</td>`}
                </tr>
              </tbody>`;
          })
          .join('')
      : `<tbody class="product-group"><tr><td class="empty" colspan="${projectTotalOnly ? 3 : 5}">No products included.</td></tr></tbody>`;

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
      if (!installationSummary) {
        return `
          <div class="card keep-together">
            <div class="card-title">Installation &amp; services</div>
            <div class="card-body">${summaryRow('Installation', '<span class="badge badge-not-included">Not included</span>')}</div>
          </div>`;
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
            summaryRow('Permit Fee', formatMoney(installationSummary.permitFee)),
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
      if (!installationSummary) {
        return `
          <div class="card keep-together">
            <div class="card-title">Project scope</div>
            <div class="card-body">${summaryRow('Installation', '<span class="badge badge-not-included">Not included</span>')}</div>
          </div>`;
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
      ${installationAmountPending ? '<p class="notice warning">Installation amount is pending.</p>' : ''}
      ${cityFeePending ? '<p class="notice warning">Final total is pending the City Fee.</p>' : ''}
      ${preliminaryInstallation && !installationAmountPending ? '<p class="notice">Installation is proposed and is not yet confirmed.</p>' : ''}`;
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
                  formatMoney(roundMoney(customerMaterial.subtotal - internalMaterial.subtotal)),
                  { extraClass: 'profit-row' },
                )
              : ''
          }
          ${notices}
        </div>`
      : `
        <div class="project-total keep-together">
          ${summaryRow(incompleteTotal ? 'Current Project Total' : 'Project Total', formatMoney(selectedProjectTotal), { strong: true })}
          ${notices}
        </div>`;

    const adminProfitability =
      reportKind === 'admin'
        ? `
          <div class="card profitability keep-together">
            <div class="card-title"><strong>Internal profitability</strong><small>Materials only - before taxes</small></div>
            <div class="profit-grid">
              ${summaryRow('Production cost', formatMoney(estimate.rateT))}
              ${summaryRow('Impact Plus profit', formatMoney(estimate.netProfit), { strong: true })}
              ${ownerIsDealer ? summaryRow('Dealer profit', formatMoney(estimate.netProfitD), { strong: true }) : ''}
            </div>
          </div>`
        : '';
    const projectSummaryHtml = projectTotalOnly
      ? `<div class="summary-start"><h2 class="section-heading">Project Summary</h2><p class="summary-intro">Products and project scope with one complete customer price.</p></div>${projectScopeHtml}${projectTotalHtml}`
      : `<div class="summary-start"><h2 class="section-heading">Project Summary</h2><p class="summary-intro">Materials, services, fees, and project totals.</p>${materialSummary}</div>${installationSummaryHtml}${projectTotalHtml}${adminProfitability}`;

    const statusBadge = estimate.status?.name
      ? `<span class="status-badge">${escapeHtml(estimate.status.name)}</span>`
      : '';
    const internalBadge = internalReport
      ? `<span class="internal-badge">Internal - ${escapeHtml(reportLabelFor(reportKind))}</span>`
      : '';
    const expirationText = estimate.expiresAt
      ? `This estimate is valid through ${formatDate(estimate.expiresAt)}.`
      : 'This estimate is valid for 30 days.';

    return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Estimate ${escapeHtml(estimate.number)} - ${escapeHtml(reportLabelFor(reportKind))}</title>
  <style>
    @page { size: Letter portrait; margin: 14mm 14mm 18mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #0f172a; font-family: Arial, Helvetica, sans-serif; font-size: 11px; line-height: 1.4; -webkit-print-color-adjust: exact; print-color-adjust: exact; orphans: 3; widows: 3; }
    .report { width: 100%; }
    .document-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 1px solid #dbe3ee; break-inside: avoid; page-break-inside: avoid; }
    h1 { margin: 0; font-size: 27px; line-height: 1.1; color: #172033; }
    .estimate-number { margin-top: 5px; color: #64748b; font-size: 13px; }
    .header-badges { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
    .status-badge, .internal-badge, .badge { display: inline-block; border-radius: 999px; padding: 3px 9px; font-size: 9px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
    .status-badge { border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; }
    .internal-badge { background: #0f172a; color: #fff; }
    .badge-not-included { border: 1px solid #f3c765; background: #fffbeb; color: #92400e; }
    .badge-included { border: 1px solid #6ee7b7; background: #ecfdf5; color: #047857; }
    .badge-proposed { border: 1px solid #93c5fd; background: #eff6ff; color: #1d4ed8; }
    .badge-preliminary { border: 1px solid #cbd5e1; background: #f8fafc; color: #475569; }
    .brand { max-width: 44%; text-align: right; color: #64748b; }
    .brand-logo { display: block; max-width: 180px; height: 46px; margin: 0 0 7px auto; object-fit: contain; }
    .brand-name { color: #334155; font-size: 18px; font-weight: 700; }
    .brand-line { margin-top: 2px; font-size: 9px; }
    .prepared-section { display: flex; justify-content: space-between; gap: 28px; margin: 22px 0 26px; break-inside: avoid; page-break-inside: avoid; }
    .prepared-details { max-width: 65%; }
    .eyebrow { margin-bottom: 6px; color: #64748b; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .prepared-name { font-size: 15px; font-weight: 700; color: #172033; }
    .project-name { margin-top: 3px; color: #475569; }
    .contact { margin-top: 7px; color: #64748b; }
    .contact div { margin-top: 2px; }
    .dates { min-width: 185px; text-align: right; color: #64748b; }
    .dates div + div { margin-top: 4px; }
    .section-heading { margin: 0 0 10px; font-size: 15px; color: #172033; break-after: avoid; page-break-after: avoid; }
    table { width: 100%; border-spacing: 0; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tbody { display: table-row-group; }
    .products-table { border: 1px solid #dbe3ee; border-radius: 8px; border-collapse: separate; }
    .products-table th { padding: 9px 10px; background: #f8fafc; color: #334155; font-size: 9px; font-weight: 700; text-align: left; text-transform: uppercase; }
    .products-table td { padding: 11px 10px; vertical-align: top; }
    .products-table .product-group + .product-group td { border-top: 1px solid #e2e8f0; }
    .product-group, .product-row, .product-row td, .description, .piece-name, .piece-detail { break-inside: avoid !important; page-break-inside: avoid !important; }
    .products-table .mark { width: 11%; font-weight: 700; }
    .products-table .description { width: 49%; }
    .products-table .center { width: 8%; text-align: center; }
    .products-table .right { width: 16%; text-align: right; }
    .products-table.prices-hidden .mark { width: 15%; }
    .products-table.prices-hidden .description { width: 70%; }
    .products-table.prices-hidden .center { width: 15%; }
    .piece-name { color: #172033; font-weight: 700; }
    .piece-detail { margin-top: 3px; color: #64748b; font-size: 9px; }
    .strong-text { font-weight: 700; }
    .empty { padding: 20px !important; text-align: center; color: #64748b; }
    .summary-section { margin-top: 28px; }
    .summary-start { break-inside: avoid; page-break-inside: avoid; }
    .summary-intro { margin: -4px 0 11px; color: #64748b; }
    .card, .project-total { margin-top: 12px; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; }
    .keep-together { break-inside: avoid; page-break-inside: avoid; }
    .card-title { padding: 10px 13px; background: #f8fafc; color: #172033; font-size: 12px; font-weight: 700; }
    .card-title small { display: block; margin-top: 2px; color: #64748b; font-size: 8px; font-weight: 400; }
    .card-body { padding: 3px 13px; }
    .summary-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 7px 0; color: #475569; }
    .summary-row > span:last-child { color: #172033; font-weight: 600; text-align: right; }
    .summary-row.strong { font-weight: 700; color: #172033; }
    .summary-row.strong > span:last-child { font-weight: 700; }
    .row-divider { border-top: 1px solid #dbe3ee; }
    .value-with-badge { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .comparison-table { border-collapse: separate; }
    .comparison-table th, .comparison-table td { padding: 9px 13px; }
    .comparison-table th { background: #f8fafc; color: #475569; font-size: 9px; text-align: left; text-transform: uppercase; }
    .comparison-table td { border-top: 1px solid #e2e8f0; color: #475569; }
    .comparison-table .right { text-align: right; color: #172033; font-weight: 600; }
    .comparison-table small { display: block; margin-top: 2px; color: #64748b; font-size: 8px; font-weight: 400; }
    .comparison-table .table-total td { background: #f8fafc; color: #172033; font-weight: 700; }
    .project-total { padding: 4px 13px; border-color: #bfdbfe; background: #eff6ff; }
    .profit-row > span:last-child { color: #047857; }
    .notice { margin: 0 0 7px; color: #1e40af; font-size: 9px; }
    .notice.warning { color: #92400e; font-weight: 600; }
    .profitability { margin-top: 14px; }
    .profit-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 30px; padding: 3px 13px; }
    .document-footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid #dbe3ee; color: #64748b; font-size: 8px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  </style>
</head><body><main class="report">
  <header class="document-header">
    <div><h1>Estimate</h1><div class="estimate-number">Number: ${escapeHtml(estimate.number)}</div><div class="header-badges">${statusBadge}${internalBadge}</div></div>
    <div class="brand">${logo}<div class="brand-name">${escapeHtml(brandingName)}</div>${brandingAddress ? `<div class="brand-line">${escapeHtml(brandingAddress)}</div>` : ''}${branding?.email ? `<div class="brand-line">${escapeHtml(branding.email)}</div>` : ''}${branding?.phone ? `<div class="brand-line">${escapeHtml(branding.phone)}</div>` : ''}${branding?.website ? `<div class="brand-line">${escapeHtml(branding.website)}</div>` : ''}</div>
  </header>
  <section class="prepared-section">
    <div class="prepared-details"><div class="eyebrow">Prepared for</div><div class="prepared-name">${escapeHtml(preparedFor)}</div>${projectName ? `<div class="project-name">Project: ${escapeHtml(projectName)}</div>` : ''}<div class="contact">${contactEmail ? `<div>${escapeHtml(contactEmail)}</div>` : ''}${contactPhone ? `<div>${escapeHtml(contactPhone)}</div>` : ''}${contactAddress ? `<div>${escapeHtml(contactAddress)}</div>` : ''}</div></div>
    <div class="dates"><div>Date: ${escapeHtml(formatDate(estimate.date))}</div>${estimate.expiresAt ? `<div>Valid through: ${escapeHtml(formatDate(estimate.expiresAt))}</div>` : ''}</div>
  </section>
  <section class="products-section"><h2 class="section-heading">Products</h2><table class="products-table${projectTotalOnly ? ' prices-hidden' : ''}"><thead><tr><th>Mark</th><th>Description</th><th class="center">Qty</th>${projectTotalOnly ? '' : '<th class="right">Unit price</th><th class="right">Subtotal</th>'}</tr></thead>${productRows}</table></section>
  <section class="summary-section">${projectSummaryHtml}</section>
  <footer class="document-footer">${escapeHtml(expirationText)} Thank you for your business.</footer>
</main></body></html>`;
  }
}

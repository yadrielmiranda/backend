import { Branding } from '@prisma/client';
import type { EstimateWithRelations, PdfView } from '../estimates.service';

export class EstimatePdfHtmlBuilder {
  static build(estimate: EstimateWithRelations, view: PdfView): string {
    const b = (estimate as any).branding as Branding | null;

    const brandingName = b?.name ?? 'Impact Plus';
    const addressLine =
      b?.street || b?.city || b?.state || b?.postalCode
        ? [b?.street, b?.city, b?.state, b?.postalCode].filter(Boolean).join(', ')
        : '';

    const esc = (v: any) =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

    const money = (n: any) => {
      const v = Number(n) || 0;
      return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    };

    const dateLabel = (() => {
      try {
        const d = new Date((estimate as any).date);
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      } catch {
        return '';
      }
    })();

    const expiresAtLabel = (() => {
      try {
        const d = new Date((estimate as any).expiresAt);
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      } catch {
        return '';
      }
    })();

    const logo = b?.logoUrl
      ? `<div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
           <img src="${esc(b.logoUrl)}" style="height:48px; object-fit:contain;" />
         </div>`
      : '';

    // comentario en espanol: rol del duenio del estimate
    const ownerRole = String((estimate as any)?.user?.role?.name ?? '')
      .trim()
      .toLowerCase();

    // comentario en espanol: si admin imprime, el "base view" depende del owner
    const effectiveView: PdfView =
      view === 'admin'
        ? ownerRole === 'dealer'
          ? 'dealer_internal'
          : 'client'
        : view;

    const isPublic = effectiveView === 'dealer_public';
    const showDealerSummary = effectiveView === 'dealer_internal';
    const showAdminSummary = view === 'admin';

    const formatInchesFromEighthStep = (raw: any) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return '?';

      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);

      const whole = Math.floor(abs);
      const frac = abs - whole;

      let eighths = Math.round(frac * 8);

      let w = whole;
      if (eighths >= 8) {
        w += 1;
        eighths = 0;
      }

      if (eighths === 0) return `${sign}${w}`;

      const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
      const g = gcd(eighths, 8);
      const num = eighths / g;
      const den = 8 / g;

      return w > 0 ? `${sign}${w} ${num}/${den}` : `${sign}${num}/${den}`;
    };

    const formatPsf = (raw: any) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return '';
      const s = n >= 0 ? '+' : '';
      return `${s}${n.toFixed(1)}`;
    };

    const buildPieceDescriptionLines = (p: any): string[] => {
      const header = [p.prod?.name, p.bran?.name, p.syst?.name, p.conf?.conf]
        .filter(Boolean)
        .join(' ');

      const w = p.width != null ? formatInchesFromEighthStep(p.width) : '?';
      const h = p.height != null ? formatInchesFromEighthStep(p.height) : '?';

      const requiresWindowHeight =
        p.conf?.requiresWindowHeight === true;

      const heightLabel = requiresWindowHeight ? 'Open H' : 'H';

      const sizeParts: string[] = [`${w} W x ${h} ${heightLabel}`];

      if (p.heightLeft != null) {
        sizeParts.push(
          `HL ${formatInchesFromEighthStep(p.heightLeft)}`,
        );
      }

      if (p.heightRight != null) {
        sizeParts.push(
          `HR ${formatInchesFromEighthStep(p.heightRight)}`,
        );
      }

      if (p.legHeight != null) {
        sizeParts.push(
          `Leg H ${formatInchesFromEighthStep(p.legHeight)}`,
        );
      }

      if (p.sashHeight != null) {
        sizeParts.push(
          `Sash H ${formatInchesFromEighthStep(p.sashHeight)}`,
        );
      }

      if (p.windowHeight != null) {
        sizeParts.push(
          `Window H ${formatInchesFromEighthStep(p.windowHeight)}`,
        );
      }

      if (p.doorWidth != null || p.doorHeight != null) {
        const doorWidth =
          p.doorWidth != null
            ? formatInchesFromEighthStep(p.doorWidth)
            : '?';

        const doorHeight =
          p.doorHeight != null
            ? formatInchesFromEighthStep(p.doorHeight)
            : '?';

        sizeParts.push(`Door ${doorWidth} W x ${doorHeight} H`);
      }

      if (p.leftSideliteWidth != null) {
        sizeParts.push(`Left SL ${formatInchesFromEighthStep(p.leftSideliteWidth)}`);
      }

      if (p.rightSideliteWidth != null) {
        sizeParts.push(`Right SL ${formatInchesFromEighthStep(p.rightSideliteWidth)}`);
      }

      if (p.leftPanels != null) {
        sizeParts.push(`Left Panels ${p.leftPanels}`);
      }

      if (p.rightPanels != null) {
        sizeParts.push(`Right Panels ${p.rightPanels}`);
      }

      if (p.panelCount != null) {
        sizeParts.push(`Panels ${p.panelCount}`);
      }

      if (Array.isArray(p.horizontalHeights) && p.horizontalHeights.length > 0) {
        sizeParts.push(
          `Horizontals ${p.horizontalHeights
            .map((h: any) => formatInchesFromEighthStep(h))
            .join(', ')}`,
        );
      }

      const sizeLine = `Size: ${sizeParts.join(' / ')}`;

      const glassTokens: string[] = [];
      if (p.cryst?.glass) glassTokens.push(p.cryst.glass);
      if (p.tin?.color) glassTokens.push(p.tin.color);
      if (p.coat?.name) glassTokens.push(p.coat.name);

      const glassLine = glassTokens.length
        ? `Glass: ${glassTokens.join(' + ')}`
        : '';

      const optionsLine = [
        `Screen: ${p.screen ? 'Yes' : 'No'}`,
        `Muntin: ${p.pieceMuntin ? 'Yes' : 'No'}`,
        `Privacy: ${p.privacy ? 'Yes' : 'No'}`,
      ].join(' | ');

      const pos = p.dpPosPsf;
      const neg = p.dpNegPsf;
      const psfLine =
        pos != null && neg != null
          ? `PSF: ${formatPsf(pos)} ${formatPsf(neg)}`
          : '';

      return [header, sizeLine, glassLine, optionsLine, psfLine].filter(
        (l) => l && l.trim() !== '',
      );
    };

    const getUnitPrice = (p: any) => {
      if (effectiveView === 'dealer_public') return Number(p.customerPrice ?? p.price) || 0;
      return Number(p.price) || 0;
    };

    const getSubtotal = (p: any) => {
      if (effectiveView === 'dealer_public') {
        const unit = getUnitPrice(p);
        const qty = Number(p.qty) || 0;
        return unit * qty;
      }

      return Number(p.subtotal ?? 0) || 0;
    };

    const rows = (estimate.pieces ?? [])
      .map((p: any) => {
        const lines = buildPieceDescriptionLines(p);

        const unitPrice = getUnitPrice(p);
        const qty = Number(p.qty) || 0;
        const subtotal = getSubtotal(p);

        const descHtml = lines
          .map((line, idx) =>
            idx === 0
              ? `<div class="h">${esc(line)}</div>`
              : `<div class="s">${esc(line)}</div>`,
          )
          .join('');

        return `
          <tr>
            <td class="td mark">${esc(p.mark)}</td>
            <td class="td desc">
              ${descHtml}
            </td>
            <td class="td center">${esc(qty)}</td>
            <td class="td right">${money(unitPrice)}</td>
            <td class="td right strong">${money(subtotal)}</td>
          </tr>
        `;
      })
      .join('');

    const subtotalInternal = Number((estimate as any).priceT ?? 0) || 0;
    const taxRate = Number((estimate as any).taxRate ?? 0) || 0;
    const taxAmount = Number((estimate as any).taxAmount ?? 0) || 0;
    const totalPayable = Number((estimate as any).totalPayable ?? 0) || 0;

    const customerSubtotal = Number((estimate as any).customerPriceT ?? 0) || 0;
    const customerTaxRate = Number((estimate as any).customerTaxRate ?? 0) || 0;
    const customerTaxAmount = Number((estimate as any).customerTaxAmount ?? 0) || 0;
    const customerTotal = Number((estimate as any).customerTotalPayable ?? 0) || 0;

    const dealerTotalDueToImpact = totalPayable;
    const dealerFinalPriceCustomer = customerSubtotal;
    const dealerProfit = Number((estimate as any).netProfitD ?? 0) || 0;

    const adminRateT = Number((estimate as any).rateT ?? 0) || 0;
    const adminPriceT = subtotalInternal;
    const adminProfit = Number((estimate as any).netProfit ?? 0) || 0;

    const installationJob = (estimate as any).installationJobDetails;
    const installationQuote = installationJob?.quotes?.[0] ?? null;
    const installationDepositPaid = (installationJob?.payments ?? []).reduce(
      (total: number, payment: any) =>
        total + Number(payment.baseAmount ?? 0),
      0,
    );
    const installationBalance = Math.max(
      0,
      Number(installationQuote?.total ?? 0) - installationDepositPaid,
    );
    const installationRows = (installationQuote?.lines ?? [])
      .map(
        (line: any) => `
          <tr>
            <td class="td desc">
              <div class="h">${esc(line.serviceNameSnapshot)}</div>
              ${line.componentLabel ? `<div class="s">${esc(line.componentLabel)}</div>` : ''}
              ${line.description ? `<div class="s">${esc(line.description)}</div>` : ''}
            </td>
            <td class="td center">${esc(String(line.origin ?? '').replaceAll('_', ' '))}</td>
            <td class="td right">${money(line.rate)}</td>
            <td class="td right">${esc(Number(line.billableQuantity ?? 0).toFixed(2))} × ${esc(line.occurrences ?? 1)}</td>
            <td class="td right strong">${money(line.adjustedAmount)}</td>
          </tr>
        `,
      )
      .join('');

    const installationSection = installationQuote
      ? `
        <div style="margin-top:22px; font-weight:700; color:#111827;">
          Installation Quote · Version ${esc(installationQuote.version)} · ${esc(String(installationQuote.status).replaceAll('_', ' '))}
        </div>
        <table>
          <thead><tr><th>Service</th><th style="width:100px; text-align:center;">Origin</th><th style="width:100px; text-align:right;">Rate</th><th style="width:110px; text-align:right;">Quantity</th><th style="width:110px; text-align:right;">Amount</th></tr></thead>
          <tbody>${installationRows}</tbody>
        </table>
        <div class="totals"><div class="totbox">
          <div class="line"><span>Installation subtotal:</span><span>${money(installationQuote.adjustedSubtotal)}</span></div>
          <div class="line"><span>Minimum adjustment:</span><span>${money(installationQuote.minimumAdjustment)}</span></div>
          <div class="line total"><span>Installation total:</span><span>${money(installationQuote.total)}</span></div>
          ${installationJob.status === 'CANCELED' && installationDepositPaid > 0 ? `
            <div class="line"><span>Installation canceled · non-refundable deposit retained:</span><span>${money(installationDepositPaid)}</span></div>
          ` : installationDepositPaid > 0 ? `
            <div class="line"><span>Non-refundable deposit paid:</span><span>-${money(installationDepositPaid)}</span></div>
            <div class="line total"><span>Installation balance:</span><span>${money(installationBalance)}</span></div>
          ` : `
            <div class="line"><span>Non-refundable deposit due:</span><span>${money(installationJob.depositAmountSnapshot)}</span></div>
          `}
        </div></div>
        <div class="s">${installationJob.status === 'CANCELED' ? 'Installation was canceled; the paid deposit remains non-refundable.' : 'The installation deposit is non-refundable and is credited in full toward the installation balance.'}</div>
        ${installationJob.permit ? `
          <div class="summary">
            <h3>Permit</h3>
            <div class="row"><span>Permit Fee:</span><span>${money(installationJob.permit.permitFeeSnapshot)}</span></div>
            <div class="row"><span>Permit status:</span><span>${esc(String(installationJob.permit.status).replaceAll('_', ' '))}</span></div>
            <div class="row"><span>City Fee:</span><span>${installationJob.permit.cityFee == null ? 'Pending' : money(installationJob.permit.cityFee)}</span></div>
          </div>` : ''}
      `
      : '';

    return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Estimate ${esc((estimate as any).number)}</title>
      <style>
    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      font-family: Arial, Helvetica, sans-serif;
      color: #111;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 10px;
      border-bottom: 1px solid #e5e7eb;
    }

    .title { font-size: 26px; font-weight: 700; margin: 0; }
    .muted { color: #6b7280; font-size: 12px; margin-top: 6px; }

    .brand { text-align: right; font-size: 12px; color: #6b7280; }
    .brand .name { font-size: 18px; font-weight: 700; color: #374151; margin-top: 6px; }

    .grid {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-top: 12px;
    }

    .label {
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #6b7280;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .value { font-size: 16px; font-weight: 700; color: #111827; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }

    thead th {
      background: #f9fafb;
      font-size: 11px;
      text-transform: uppercase;
      color: #374151;
      padding: 9px 10px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }

    .td {
      padding: 10px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
      font-size: 12px;
    }

    .center { text-align: center; }
    .right { text-align: right; }
    .strong { font-weight: 700; }

    .h { font-weight: 700; color: #111827; font-size: 12px; }
    .s { color: #6b7280; font-size: 11px; margin-top: 4px; line-height: 1.35; }

    .totals { display: flex; justify-content: flex-end; margin-top: 10px; }
    .totbox { min-width: 300px; }

    .sectionTitle {
      font-size: 12px;
      font-weight: 700;
      color: #374151;
      margin: 0 0 6px 0;
    }

    .line {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12px;
      color: #374151;
    }

    .line.total {
      border-top: 2px solid #e5e7eb;
      padding-top: 8px;
      font-size: 14px;
      font-weight: 800;
      color: #111827;
    }

    .summary {
      margin-top: 14px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #f9fafb;
      font-size: 12px;
      color: #374151;
    }

    .summary h3 {
      margin: 0 0 10px 0;
      font-size: 14px;
      font-weight: 800;
      color: #111827;
    }

    .summary .row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-top: 1px solid #e5e7eb;
    }

    .summary .row:first-of-type { border-top: none; padding-top: 0; }

    .summary .profit {
      font-weight: 900;
      color: #065f46;
    }

    .summary .adminprofit {
      font-weight: 900;
      color: #991b1b;
    }

    .footer {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      font-size: 10px;
      color: #6b7280;
    }
  </style>
  </head>
  <body>
  <div>
    <div class="header">
      <div>
        <h1 class="title">Estimate</h1>
        <div class="muted">Number: ${esc((estimate as any).number)}</div>
      </div>

      <div class="brand">
        ${logo}
        <div class="name">${esc(brandingName)}</div>
        ${addressLine ? `<div>${esc(addressLine)}</div>` : ``}
        ${b?.email ? `<div>${esc(b.email)}</div>` : ``}
        ${b?.phone ? `<div>${esc(b.phone)}</div>` : ``}
        ${b?.website ? `<div>${esc(b.website)}</div>` : ``}
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="label">Prepared For</div>
        <div class="value">${esc((estimate as any).name)}</div>
      </div>
      <div style="text-align:right;">
        <div class="muted">Date: ${esc(dateLabel)}</div>
      </div>
    </div>

    <div style="margin-top:16px; font-weight:700; color:#111827;">Pieces Detail</div>

    <table>
      <thead>
        <tr>
          <th style="width:80px;">Mark</th>
          <th>Description</th>
          <th style="width:70px; text-align:center;">Qty</th>
          <th style="width:120px; text-align:right;">Unit Price</th>
          <th style="width:120px; text-align:right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="totals">
      <div class="totbox">
        ${isPublic
        ? `
              <div class="line">
                <span>Subtotal:</span>
                <span>${money(customerSubtotal)}</span>
              </div>
              <div class="line">
                <span>Sales Tax (${(customerTaxRate * 100).toFixed(2)}%):</span>
                <span>${money(customerTaxAmount)}</span>
              </div>
              <div class="line total">
                <span>Total:</span>
                <span>${money(customerTotal)}</span>
              </div>
            `
        : effectiveView === 'dealer_internal'
          ? `
                <div class="sectionTitle">Customer View Total</div>
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(customerSubtotal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(customerTaxRate * 100).toFixed(2)}%):</span>
                  <span>${money(customerTaxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(customerTotal)}</span>
                </div>

                <div style="height:14px;"></div>

                <div class="sectionTitle">Internal Totals</div>
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(subtotalInternal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(taxRate * 100).toFixed(2)}%):</span>
                  <span>${money(taxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(totalPayable)}</span>
                </div>
              `
          : `
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(subtotalInternal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(taxRate * 100).toFixed(2)}%):</span>
                  <span>${money(taxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(totalPayable)}</span>
                </div>
              `
      }
      </div>
    </div>

    ${installationSection}

    ${showDealerSummary
        ? `
          <div class="summary" style="background:#ecfdf5; border-color:#bbf7d0;">
            <h3 style="color:#065f46;">Dealer Summary</h3>
            <div class="row"><span>Total Due to Impact Plus:</span><span>${money(dealerTotalDueToImpact)}</span></div>
            <div class="row"><span>Final Price for Your Customer:</span><span>${money(dealerFinalPriceCustomer)}</span></div>
            <div class="row"><span>Your Profit (Net Profit):</span><span class="profit">${money(dealerProfit)}</span></div>
          </div>
        `
        : ''
      }

    ${showAdminSummary
        ? `
          <div class="summary" style="background:#fef2f2; border-color:#fecaca;">
            <h3 style="color:#991b1b;">Admin Summary</h3>
            <div class="row"><span>Total Production Cost (Rate):</span><span>${money(adminRateT)}</span></div>
            <div class="row"><span>Sale Price (Before Taxes):</span><span>${money(adminPriceT)}</span></div>
            <div class="row"><span>Impact Plus Profit (Net Profit):</span><span class="adminprofit">${money(adminProfit)}</span></div>
          </div>
        `
        : ''
      }

    <div class="footer">
      This estimate is valid until ${esc(expiresAtLabel)}. Thank you for your business.
    </div>
   </div>
    </body>
    </html>
    `;
  }
}

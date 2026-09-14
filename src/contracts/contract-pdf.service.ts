import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import puppeteer from 'puppeteer';
import { EstimatePdfHtmlBuilder } from '@/estimates/pdf/estimate-pdf-html.builder';

export type SignaturePoint = { x: number; y: number };
export type SignatureStrokes = SignaturePoint[][];
// Una misma presentación para el PDF y la página, con el horario de verano de Miami.
const agreementTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'short',
});

export const formatAgreementSignedAt = (date: Date) =>
  agreementTimeFormatter.format(date);

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export const AGREEMENT_CONSENT =
  'I agree to the estimate and contract shown above and consent to sign electronically.';
export const CHANGE_ORDER_CONSENT =
  'I agree to the charges and updated total in this Change Order. The products and all other terms of the referenced signed agreement remain unchanged. I consent to sign electronically.';

export function changeOrderHtml(snapshot: any) {
  const change = snapshot.changeOrder;
  const usd = (value: unknown) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(Number(value));
  const amount = (line: any) =>
    !line ? 'Not included' : line.amount == null ? 'Pending' : usd(line.amount);
  const rows = change.items
    .map(
      (item: any) =>
        `<tr><td>${escapeHtml(item.description)}</td><td>${escapeHtml(amount(item.before))}</td><td>${escapeHtml(amount(item.after))}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 18mm; } * { box-sizing: border-box; } body { font: 12px Arial,sans-serif; color: #111827; }
    h1 { font-size: 25px; margin-bottom: 8px; } h2 { font-size: 15px; margin-top: 26px; } .muted { color: #475569; line-height: 1.6; }
    table { width:100%; border-collapse:collapse; margin:20px 0; } th,td { text-align:left; padding:12px 8px; border-bottom:1px solid #e2e8f0; } th { background:#f8fafc; }
    td:nth-child(n+2),th:nth-child(n+2) { text-align:right; } tr { break-inside:avoid; }
    .totals { margin-top:22px; padding:16px; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; break-inside:avoid; }
    .row { display:flex; justify-content:space-between; gap:20px; margin:10px 0; } .total { font-size:18px; font-weight:bold; } p { line-height:1.6; }
    </style></head><body><h1>Change Order #${escapeHtml(change.number)}</h1>
    <div class="muted">${escapeHtml(snapshot.branding?.name)} · Estimate #${escapeHtml(snapshot.number)}<br>
    Prepared for ${escapeHtml(snapshot.customerFirstName)} ${escapeHtml(snapshot.customerLastName)}<br>
    Project: ${escapeHtml(snapshot.name)}<br>References signed agreement revision ${escapeHtml(change.baseRevision)}</div>
    <h2>Charges updated</h2>${
      rows
        ? `<table><thead><tr><th>Charge</th><th>Previously accepted</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p>${change.changedCharges.map(escapeHtml).join(' · ')}</p><p class="muted">This customer report shows the project total without a price breakdown.</p>`
    }
    <div class="totals"><div class="row"><span>${change.previousIncomplete ? 'Previous known total' : 'Previous project total'}</span><strong>${usd(change.previousTotal)}</strong></div>
    <div class="row"><span>Adjustment to known total</span><strong>${usd(change.difference)}</strong></div>
    <div class="row total"><span>${change.newIncomplete ? 'Updated known total' : 'Updated project total'}</span><strong>${usd(change.newTotal)}</strong></div></div>
    ${change.newIncomplete ? '<p class="muted">Charges marked Pending remain to be determined and are excluded from the known total.</p>' : ''}
    <p>This Change Order updates only the charges listed above. The products and all other terms of the referenced signed agreement remain unchanged.</p>
    <p class="muted">The project total is not a request to pay that amount now. Payments already made remain credited; payment amounts follow the project payment schedule.</p>
    </body></html>`;
}

export function agreementQuoteReport(snapshot: any) {
  const totalOnly = snapshot.publicPricingMode === 'total';
  return {
    ...snapshot,
    rateT: '0.00',
    priceT: '0.00',
    netProfit: '0.00',
    taxRate: 0,
    taxAmount: '0.00',
    totalPayable: '0.00',
    units: snapshot.pieces.reduce(
      (sum: number, piece: any) => sum + piece.qty,
      0,
    ),
    user: {
      role: { name: 'dealer' },
      dealerMode: snapshot.customerPromotionsVisible ? 'INTERNAL' : 'EXTERNAL',
    },
    dealerModeSnapshot: snapshot.customerPromotionsVisible
      ? 'INTERNAL'
      : 'EXTERNAL',
    customerTotalPayable: totalOnly
      ? snapshot.publicProjectTotal
      : snapshot.customerTotalPayable,
    pieces: snapshot.pieces.map((piece: any) => ({
      ...piece,
      promotionSnapshot:
        piece.regularCustomerPrice == null ? null : { present: true },
    })),
  };
}

@Injectable()
export class ContractPdfService {
  private running = 0;

  private async browser<T>(
    work: (browser: Awaited<ReturnType<typeof puppeteer.launch>>) => Promise<T>,
  ) {
    if (this.running >= 2)
      throw new ServiceUnavailableException(
        'Documents are being prepared. Please try again shortly.',
      );
    this.running++;
    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    try {
      browser = await puppeteer.launch({
        headless: 'shell',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
      return await work(browser);
    } finally {
      await browser?.close();
      this.running--;
    }
  }

  async quote(snapshot: any, token: string, agreementId: string) {
    const frontend =
      process.env.PDF_RENDER_FRONTEND_URL ||
      process.env.PUBLIC_FRONTEND_URL ||
      process.env.FRONTEND_URL?.split(',')[0]?.trim();
    if (!frontend)
      throw new ServiceUnavailableException(
        'Configure PDF_RENDER_FRONTEND_URL or FRONTEND_URL to prepare agreements.',
      );
    return this.browser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({
        width: 1440,
        height: 1200,
        deviceScaleFactor: 2,
      });
      const url = new URL(
        `/public/estimates/${encodeURIComponent(token)}/agreements/${agreementId}`,
        frontend,
      );
      url.searchParams.set('render', '1');
      await page.goto(url.toString(), {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      await page.waitForSelector(
        `[data-agreement-snapshot="${agreementId}"] [data-piece-diagram-id]`,
        { timeout: 20000 },
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const diagrams: Record<string, string> = {};
      for (const element of await page.$$('[data-piece-diagram-id]')) {
        const id = await element.evaluate((node) =>
          node.getAttribute('data-piece-diagram-id'),
        );
        diagrams[id!] =
          `data:image/png;base64,${Buffer.from(await element.screenshot({ type: 'png' })).toString('base64')}`;
      }
      if (Object.keys(diagrams).length !== snapshot.pieces.length)
        throw new ServiceUnavailableException(
          'Could not render all pieces. Please try again.',
        );
      const totalOnly = snapshot.publicPricingMode === 'total';
      // La entrada al generador contiene exclusivamente la cotización pública congelada.
      const report = agreementQuoteReport(snapshot);
      const view = totalOnly ? 'dealer_public_total' : 'dealer_public';
      const html = EstimatePdfHtmlBuilder.build(report as any, view, diagrams);
      const pdfPage = await browser.newPage();
      await pdfPage.setRequestInterception(true);
      pdfPage.on('request', (request) =>
        request.url().startsWith('data:') || request.url() === 'about:blank'
          ? request.continue()
          : request.abort(),
      );
      await pdfPage.setContent(html, { waitUntil: 'networkidle0' });
      await pdfPage.emulateMediaType('print');
      const footer = `Estimate #${escapeHtml(snapshot.number)} - ${totalOnly ? 'Project total' : 'Detailed prices'}`;
      return Buffer.from(
        await pdfPage.pdf({
          format: 'Letter',
          printBackground: true,
          displayHeaderFooter: true,
          preferCSSPageSize: true,
          headerTemplate: '<span></span>',
          footerTemplate: `<div style="font:8px Arial;width:100%;text-align:center;padding:0 14mm;">${footer} - Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
        }),
      );
    });
  }

  async receipt(params: {
    agreement: any;
    signerName: string;
    strokes: SignatureStrokes;
    signedAt: Date;
  }) {
    const { agreement, signerName, strokes, signedAt } = params;
    const snapshot = agreement.snapshot;
    const paths = strokes
      .map(
        (stroke) =>
          `<polyline points="${stroke.map((point) => `${point.x * 600},${point.y * 180}`).join(' ')}" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join('');
    const row = (label: string, value: unknown) =>
      `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: Letter; margin: 18mm; } * { box-sizing: border-box; } body { font: 12px Arial,sans-serif; color: #111827; } h1 { font-size: 25px; margin: 0 0 8px; } h2 { font-size: 15px; margin: 25px 0 10px; } .sub { color: #475569; } .row { display: flex; justify-content: space-between; gap: 20px; border-bottom: 1px solid #e2e8f0; padding: 9px 0; } strong { text-align: right; overflow-wrap: anywhere; } .consent { line-height: 1.6; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; } svg { width: 100%; height: 130px; border-bottom: 1px solid #64748b; } .note { margin-top: 20px; font-size: 10px; color: #475569; line-height: 1.5; }
      </style></head><body><h1>Electronic acceptance</h1><div class="sub">${escapeHtml(snapshot.branding?.name)} · Estimate #${escapeHtml(snapshot.number)}</div>
      <h2>${agreement.baseAgreementId ? `Change Order #${escapeHtml(agreement.changeOrderNumber)}` : 'Agreement'}</h2>${agreement.baseAgreementId ? row('Referenced agreement revision', snapshot.changeOrder.baseRevision) : ''}${row('Customer report', agreement.pricingMode === 'total' ? 'Project total' : 'Detailed prices')}${row('Dealer contract', agreement.contract.name)}${row('Signed by', signerName)}${row('Signed at', formatAgreementSignedAt(signedAt))}
      <h2>Acceptance</h2><div class="consent">${escapeHtml(agreement.consentText ?? AGREEMENT_CONSENT)}</div><h2>Signature</h2><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180">${paths}</svg>
      <p class="note">${agreement.baseAgreementId ? 'This acceptance applies to the Change Order included in this document and references the previously signed agreement. The products and all other terms remain unchanged.' : 'This acceptance applies to the saved estimate and dealer contract included in this document. Changes to the agreed products, prices or terms require a new acceptance.'}</p></body></html>`;
    return this.browser(async (browser) => {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return Buffer.from(
        await page.pdf({
          format: 'Letter',
          printBackground: true,
          preferCSSPageSize: true,
        }),
      );
    });
  }

  async changeOrder(snapshot: any) {
    return this.browser(async (browser) => {
      const page = await browser.newPage();
      await page.setContent(changeOrderHtml(snapshot), { waitUntil: 'load' });
      return Buffer.from(
        await page.pdf({
          format: 'Letter',
          printBackground: true,
          preferCSSPageSize: true,
        }),
      );
    });
  }
}

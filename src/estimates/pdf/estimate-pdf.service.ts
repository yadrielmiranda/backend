import { Injectable, BadRequestException } from '@nestjs/common';
import puppeteer from 'puppeteer';
import type { AuthUser } from '@/auth/types/auth-user.type';
import type { EstimateWithRelations, PdfView } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';

@Injectable()
export class EstimatePdfService {
  assertPdfViewAllowed(view: PdfView, roleName: string | null) {
    // comentario en espanol: bloqueamos vistas que no corresponden al rol
    if (roleName === 'client') {
      if (view !== 'client') {
        throw new BadRequestException('View not allowed.');
      }
      return;
    }

    if (roleName === 'dealer') {
      if (
        view !== 'dealer_internal' &&
        view !== 'dealer_public' &&
        view !== 'dealer_public_total'
      ) {
        throw new BadRequestException('View not allowed.');
      }
      return;
    }

    if (roleName === 'admin' || roleName === 'operator') {
      // comentario en espanol: admin/operator pueden imprimir todo
      return;
    }

    throw new BadRequestException('Role not allowed.');
  }

  async generateEstimatePdfBuffer(params: {
    estimate: EstimateWithRelations;
    user: AuthUser;
    view: PdfView;
  }): Promise<Buffer> {
    const { estimate, user, view } = params;

    const viewerRole = user.role?.name ?? null;

    this.assertPdfViewAllowed(view, viewerRole);

    const html = EstimatePdfHtmlBuilder.build(estimate, view);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();

      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('print');
      await page.evaluate(async () => {
        await document.fonts?.ready;
        await Promise.all(
          Array.from(document.images).map(
            (image) =>
              new Promise<void>((resolve) => {
                if (image.complete) {
                  resolve();
                  return;
                }

                image.addEventListener('load', () => resolve(), { once: true });
                image.addEventListener('error', () => resolve(), { once: true });
              }),
          ),
        );
      });

      const estimateNumber = String(estimate.number ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');

      const pdf = await page.pdf({
        format: 'Letter',
        printBackground: true,
        displayHeaderFooter: true,
        preferCSSPageSize: true,
        headerTemplate: '<span></span>',
        footerTemplate: `
          <div style="box-sizing:border-box;width:100%;padding:0 14mm;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:8px;text-align:center;">
            Estimate #${estimateNumber} - Page <span class="pageNumber"></span> of <span class="totalPages"></span>
          </div>`,
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

} 

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parse as parseCookieHeader } from 'cookie';
import puppeteer from 'puppeteer';
import type { AuthUser } from '@/auth/types/auth-user.type';
import type { EstimateWithRelations, PdfView } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

@Injectable()
export class EstimatePdfService {
  private readonly logger = new Logger(EstimatePdfService.name);

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
    cookieHeader?: string;
  }): Promise<Buffer> {
    const { estimate, user, view, cookieHeader } = params;

    const viewerRole = user.role?.name ?? null;

    this.assertPdfViewAllowed(view, viewerRole);

    const browser = await puppeteer.launch({
      headless: 'shell',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    try {
      const diagramRenders = await this.capturePieceDiagrams({
        browser,
        estimate,
        cookieHeader,
      });
      const html = EstimatePdfHtmlBuilder.build(estimate, view, diagramRenders);
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
                image.addEventListener('error', () => resolve(), {
                  once: true,
                });
              }),
          ),
        );
      });

      const estimateNumber = escapeHtml(estimate.number);
      const footerText = escapeHtml(
        EstimatePdfHtmlBuilder.buildFooterText(estimate),
      );

      const pdf = await page.pdf({
        format: 'Letter',
        printBackground: true,
        displayHeaderFooter: true,
        preferCSSPageSize: true,
        headerTemplate: '<span></span>',
        footerTemplate: `
          <div style="box-sizing:border-box;width:100%;padding:0 14mm;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:8px;text-align:center;">
            <div style="border-top:1px solid #dbe3ee;padding-top:6px;">${footerText}</div>
            <div style="margin-top:3px;">Estimate #${estimateNumber} - Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
          </div>`,
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private resolveFrontendUrl() {
    const configured =
      process.env.PDF_RENDER_FRONTEND_URL ??
      process.env.PUBLIC_FRONTEND_URL ??
      process.env.FRONTEND_URL?.split(',')[0]?.trim();

    if (!configured) return null;

    try {
      const url = new URL(configured);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url;
    } catch {
      return null;
    }
  }

  private async capturePieceDiagrams(params: {
    browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    estimate: EstimateWithRelations;
    cookieHeader?: string;
  }): Promise<Record<string, string>> {
    const { browser, estimate, cookieHeader } = params;
    const frontendUrl = this.resolveFrontendUrl();

    if (!frontendUrl || estimate.pieces.length === 0) return {};

    const page = await browser.newPage();

    try {
      await page.setViewport({
        width: 1440,
        height: 1200,
        deviceScaleFactor: 2,
      });

      if (cookieHeader) {
        const pageOrigin = `${frontendUrl.protocol}//${frontendUrl.host}/`;
        const cookies = Object.entries(parseCookieHeader(cookieHeader)).map(
          ([name, value]) => ({ name, value, url: pageOrigin }),
        );

        if (cookies.length > 0) {
          await page.setCookie(...cookies);
        }
      }

      const reportUrl = new URL(`/estimates/${estimate.id}`, frontendUrl);
      reportUrl.searchParams.set('pdfDiagramCapture', '1');

      await page.goto(reportUrl.toString(), {
        waitUntil: 'networkidle2',
        timeout: 45_000,
      });
      await page.waitForSelector('[data-piece-diagram-id]', {
        timeout: 20_000,
      });
      await page.evaluate(async () => {
        await document.fonts?.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );

        document
          .querySelectorAll<HTMLElement>('[data-piece-mark-badge]')
          .forEach((badge) => {
            badge.style.visibility = 'hidden';
          });
      });

      const renders: Record<string, string> = {};
      const elements = await page.$$('[data-piece-diagram-id]');

      for (const element of elements) {
        const pieceId = await element.evaluate((node) =>
          node.getAttribute('data-piece-diagram-id'),
        );
        if (!pieceId) continue;

        // comentario en español: la imagen queda embebida para que el PDF sea autónomo.
        const screenshot = await element.screenshot({
          type: 'png',
          omitBackground: false,
        });
        renders[pieceId] =
          `data:image/png;base64,${Buffer.from(screenshot).toString('base64')}`;
      }

      return renders;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `No se pudieron capturar los diagramas del estimate ${estimate.id}: ${message}`,
      );
      return {};
    } finally {
      await page.close();
    }
  }
}

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
      if (view !== 'dealer_internal' && view !== 'dealer_public') {
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

    const viewerRole =
      (user as any)?.role?.name ??
      (user as any)?.roleName ??
      (estimate as any)?.user?.role?.name ??
      null;

    this.assertPdfViewAllowed(view, viewerRole);

    const html = EstimatePdfHtmlBuilder.build(estimate, view);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();

      // comentario en espanol: si el logoUrl es externo, esto ayuda a que cargue completo
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        format: 'Letter',
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        margin: {
          top: '24mm',
          right: '16mm',
          bottom: '12mm',
          left: '16mm',
        },
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

} 
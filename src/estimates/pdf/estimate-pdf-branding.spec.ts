import type { EstimateWithRelations, PdfView } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';

const fixture = () => ({
  id: 9, idUser: 7, number: 190936, name: 'Test project',
  date: new Date('2026-09-22T12:00:00Z'),
  expiresAt: new Date('2026-11-04T12:00:00Z'),
  status: { name: 'Active' }, dealerModeSnapshot: 'EXTERNAL',
  priceT: '100.00', rateT: '80.00', taxRate: '0', taxAmount: '0',
  totalPayable: '100.00', customerPriceT: '120.00', customerTaxRate: '0',
  customerTaxAmount: '0', customerTotalPayable: '120.00',
  user: {
    id: 7, firstName: 'Pepe', lastName: 'Ernandez',
    phone: '+1 (999) 999-9999', email: 'dealer@example.com',
    role: { name: 'dealer' }, dealerMode: 'EXTERNAL',
  },
  branding: {
    type: 'COMPANY', isActive: true, name: 'Authentic Evolution',
    phone: 'PLATFORM-PHONE', email: 'platform@example.com',
    street: 'PLATFORM-ADDRESS', website: 'platform.example.com',
    logoUrl: 'data:image/png;base64,logo', brandingColor: '#CC0000',
  },
  pieces: [],
}) as unknown as EstimateWithRelations;

const render = (estimate: EstimateWithRelations, view: PdfView = 'dealer_public') =>
  EstimatePdfHtmlBuilder.build(estimate, view, {}, 1, 'admin', true);

describe('external dealer estimate PDF branding', () => {
  it.each<PdfView>(['dealer_public', 'dealer_public_total', 'dealer_internal', 'admin', 'client'])(
    'uses owner identity and the unchanged platform logo in %s', view => {
      const estimate = fixture();
      const html = render(estimate, view);
      expect(html).toContain('<div class="brand-name">Pepe Ernandez</div>');
      expect(html).toContain('Independent Distributor');
      expect(html).toContain('dealer@example.com');
      expect(html).toContain('+1 (999) 999-9999');
      expect(html).toContain('Generated with Authentic Evolution');
      expect(html).toContain('src="data:image/png;base64,logo"');
      expect(html).toContain('width: 230px; height: 112px;');
      expect(html).not.toMatch(/PLATFORM-PHONE|platform@example.com|PLATFORM-ADDRESS|platform\.example\.com/);
      expect(html).toContain('margin: 12mm 12mm 28mm');
    },
  );

  it('places the issuer above the divider and a linked platform reference below it', () => {
    const html = EstimatePdfHtmlBuilder.buildFooterTemplate(fixture(), 'dealer_public', true);
    expect(html).toContain('This estimate is issued by Pepe Ernandez, an independent distributor.');
    expect(html.indexOf('This estimate is issued by')).toBeLessThan(html.indexOf('border-top:'));
    expect(html.indexOf('Generated with Authentic Evolution')).toBeGreaterThan(html.indexOf('border-top:'));
    expect(html).toContain('href="http://www.authenticevolutionco.com"');
    expect(html).toContain('www.authenticevolutionco.com</a>');
    expect(html).toContain('This estimate is valid through November 4, 2026.');
    expect(html).toContain('class="pageNumber"');
    expect(html).not.toMatch(/Platform support|platform@example.com|PLATFORM-PHONE/);
  });

  it.each(['internal', 'own-branding', 'non-dealer'])(
    'preserves the original HTML and footer for %s', scenario => {
      const estimate = fixture();
      if (scenario === 'internal') {
        estimate.user.dealerMode = estimate.dealerModeSnapshot = 'INTERNAL';
      } else if (scenario === 'own-branding') {
        estimate.branding!.type = 'DEALER';
        estimate.branding!.userId = estimate.idUser;
      } else {
        estimate.user.role.name = 'client';
      }
      expect(render(estimate)).toBe(
        EstimatePdfHtmlBuilder.build(estimate, 'dealer_public', {}, 1, 'admin'),
      );
      expect(EstimatePdfHtmlBuilder.buildFooterTemplate(estimate, 'dealer_public', true)).toBe(
        EstimatePdfHtmlBuilder.buildFooterTemplate(estimate, 'dealer_public'),
      );
    },
  );

  it('keeps callers without an explicit opt-in on the original presentation', () => {
    const estimate = fixture();
    const html = EstimatePdfHtmlBuilder.build(estimate, 'dealer_public');
    expect(html).toContain('<div class="brand-name">Authentic Evolution</div>');
    expect(html).toContain('platform@example.com');
    expect(html).not.toContain('Generated with Authentic Evolution');
    expect(html).not.toContain('Independent Distributor');
    expect(html).toContain('margin: 12mm 12mm 18mm');
  });

  it('uses saved agreement identity instead of the synthetic report owner', () => {
    const estimate = fixture();
    estimate.externalDealerPresentation = {
      name: 'Saved Distributor', phone: 'saved-phone', email: 'saved@example.com',
    };
    const html = render(estimate);
    const footer = EstimatePdfHtmlBuilder.buildFooterTemplate(estimate, 'dealer_public', true);
    expect(html).toContain('<div class="brand-name">Saved Distributor</div>');
    expect(html).toContain('saved@example.com');
    expect(html).not.toContain('Pepe Ernandez');
    expect(footer).toContain('This estimate is issued by Saved Distributor, an independent distributor.');
    estimate.externalDealerPresentation = null;
    expect(render(estimate)).not.toContain('Generated with Authentic Evolution');
  });

  it('escapes owner identity and omits missing contacts without company fallback', () => {
    const estimate = fixture();
    estimate.user.firstName = '<script>alert(1)</script>';
    estimate.user.phone = null;
    estimate.user.email = null;
    const html = render(estimate);
    const footer = EstimatePdfHtmlBuilder.buildFooterTemplate(estimate, 'dealer_public', true);
    for (const result of [html, footer]) {
      expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Ernandez');
      expect(result).not.toContain('<script>');
      expect(result).not.toMatch(/PLATFORM-PHONE|platform@example.com/);
    }
  });
});

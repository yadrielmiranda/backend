import type { EstimateWithRelations } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';

const estimateFixture = (installationIncluded = true) =>
  ({
    id: 9,
    number: 190918,
    name: 'Replacement windows',
    date: new Date('2026-08-18T12:00:00.000Z'),
    expiresAt: new Date('2026-09-17T12:00:00.000Z'),
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerEmail: 'customer@example.com',
    customerPhone: '+1 305 555 0123',
    customerStreet: '100 Main Street',
    customerCity: 'Miami',
    customerState: 'FL',
    customerPostalCode: '33175',
    priceT: '227.78',
    taxRate: '0.07',
    taxAmount: '15.94',
    totalPayable: '243.72',
    customerPriceT: '261.95',
    customerTaxRate: '0.07',
    customerTaxAmount: '18.34',
    customerTotalPayable: '280.29',
    rateT: '198.07',
    netProfit: '29.71',
    netProfitD: '34.17',
    status: { name: 'Active' },
    user: {
      firstName: 'Dealer',
      lastName: 'Owner',
      role: { name: 'dealer' },
    },
    branding: { name: 'Dealer Windows' },
    pieces: [
      {
        mark: 'F1',
        qty: 1,
        width: 35,
        height: 62,
        screen: true,
        prod: { name: 'Single Hung' },
        bran: { name: 'Eco Windows' },
        syst: { name: 'Series 100' },
        conf: { conf: 'Equal Lites' },
        cryst: { glass: '3/16 + 3/16' },
        tin: { color: 'Clear' },
        coat: { name: 'None' },
        privacyOption: null,
        price: '227.78',
        subtotal: '227.78',
        customerPrice: '261.95',
        customerSubtotal: '261.95',
      },
    ],
    installationSummary: installationIncluded
      ? {
          status: 'REQUESTED',
          quoteStatus: 'DRAFT',
          installationAmount: '400.00',
          installationTotal: '525.00',
          additionalServices: [
            { serviceId: 22, name: 'Concrete Cutting', amount: '125.00' },
          ],
          permitIncluded: true,
          permitFee: '1000.00',
          cityFee: null,
        }
      : null,
  }) as unknown as EstimateWithRelations;

describe('EstimatePdfHtmlBuilder', () => {
  it('keeps the dealer customer PDF free of internal pricing', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(),
      'dealer_public',
    );

    expect(html).toContain('$261.95');
    expect(html).not.toContain('$227.78');
    expect(html).not.toContain('$243.72');
    expect(html).not.toContain('Internal profitability');
    expect(html).not.toContain('Production cost');
  });

  it('shows only the not-included installation row when there is no installation', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(false),
      'dealer_public',
    );

    expect(html).toContain('Installation &amp; services');
    expect(html).toContain('Not included');
    expect(html).not.toContain('Additional services');
    expect(html).not.toContain('Permit service');
    expect(html).not.toContain('City Fee');
  });

  it('consolidates automatic installation work and names only manual extras', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(),
      'dealer_internal',
    );

    expect(html).toContain('Your Cost');
    expect(html).toContain('Customer Price');
    expect(html).toContain('Concrete Cutting');
    expect(html).not.toContain('Installation Quote');
    expect(html).not.toContain('Non-refundable deposit');
    expect(html).not.toContain('USER_SELECTED');
    expect(html).not.toContain('FIELD_ADDED');
  });

  it('renders the dealer project-total PDF without itemized customer prices', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(),
      'dealer_public_total',
    );

    expect(html).toContain('Concrete Cutting');
    expect(html).toContain('Project scope');
    expect(html).toContain('Current Project Total');
    expect(html).toContain('$1,805.29');
    expect(html).not.toContain('Unit price');
    expect(html).not.toContain('Material subtotal');
    expect(html).not.toContain('Sales Tax');
    expect(html).not.toContain('$261.95');
    expect(html).not.toContain('$125.00');
    expect(html).not.toContain('$1,000.00');
  });

  it('keeps installation explicitly excluded in a project-total PDF', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(false),
      'dealer_public_total',
    );

    expect(html).toContain('Installation');
    expect(html).toContain('Not included');
    expect(html).toContain('Project Total');
    expect(html).toContain('$280.29');
    expect(html).not.toContain('Additional services');
    expect(html).not.toContain('Permit service');
  });

  it('includes print fragmentation rules for product rows and repeated headers', () => {
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin');

    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('.product-row');
    expect(html).toContain('page-break-inside: avoid !important;');
    expect(html).toContain('Internal profitability');
  });

  it('keeps the expiration message in the real PDF footer instead of the document flow', () => {
    const estimate = estimateFixture();
    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin');

    expect(EstimatePdfHtmlBuilder.buildFooterText(estimate)).toBe(
      'This estimate is valid through September 17, 2026. Thank you for your business.',
    );
    expect(html).not.toContain('document-footer');
    expect(html).not.toContain('Thank you for your business.');
  });
});

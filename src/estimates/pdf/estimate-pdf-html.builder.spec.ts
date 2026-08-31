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
    dealerModeSnapshot: 'EXTERNAL',
    dealerAffiliationSnapshot: 'AUTHENTIC',
    status: { name: 'Active' },
    user: {
      firstName: 'Dealer',
      lastName: 'Owner',
      role: { name: 'dealer' },
    },
    branding: { name: 'Dealer Windows' },
    pieces: [
      {
        id: 77,
        mark: 'F1',
        qty: 1,
        width: 35,
        height: 62,
        screen: true,
        prod: { name: 'Single Hung' },
        bran: { name: 'Eco Windows' },
        syst: { name: 'Series 100' },
        conf: { conf: 'Equal Lites' },
        fColor: { color: 'Bronze' },
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

function withExternalDealerCustomerCharges(
  estimate = estimateFixture(),
): EstimateWithRelations {
  estimate.customerChargesSummary = {
    enabled: true,
    systemTotal: '1525.00',
    customerTotal: '2300.00',
    knownSystemMargin: '475.00',
    dealerCreatedTotal: '300.00',
    systemTotalIncomplete: true,
    customerTotalIncomplete: false,
    lines: [
      {
        id: 1,
        origin: 'SYSTEM',
        source: 'INSTALLATION',
        sourceKey: 'INSTALLATION',
        sourceRefId: null,
        description: 'Installation',
        systemAmount: '400.00',
        customerAmount: '650.00',
        pricingMode: 'FINAL',
        pricingValue: '650.0000',
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: 10,
      },
      {
        id: 2,
        origin: 'SYSTEM',
        source: 'INSTALLATION_SERVICE',
        sourceKey: 'SERVICE:22',
        sourceRefId: 22,
        description: 'Concrete Cutting',
        systemAmount: '125.00',
        customerAmount: '175.00',
        pricingMode: 'AMOUNT',
        pricingValue: '50.0000',
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: 100,
      },
      {
        id: 3,
        origin: 'SYSTEM',
        source: 'PERMIT',
        sourceKey: 'PERMIT',
        sourceRefId: null,
        description: 'Permit Fee',
        systemAmount: '1000.00',
        customerAmount: '1100.00',
        pricingMode: 'AMOUNT',
        pricingValue: '100.0000',
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: 900,
      },
      {
        id: 4,
        origin: 'SYSTEM',
        source: 'CITY_FEE',
        sourceKey: 'CITY_FEE',
        sourceRefId: null,
        description: 'City Fee',
        systemAmount: null,
        customerAmount: '75.00',
        pricingMode: 'FINAL',
        pricingValue: '75.0000',
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: 910,
      },
      {
        id: 5,
        origin: 'DEALER',
        source: 'CUSTOM',
        sourceKey: null,
        sourceRefId: null,
        description: 'Remove shutters',
        systemAmount: null,
        customerAmount: '300.00',
        pricingMode: 'FINAL',
        pricingValue: '300.0000',
        usedInCustomerQuote: true,
        needsReview: false,
        sortOrder: 1000,
      },
    ],
  };

  return estimate;
}

describe('EstimatePdfHtmlBuilder', () => {
  it('keeps the dealer customer PDF free of internal pricing', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(),
      'dealer_public',
    );

    expect(html).toContain('$261.95');
    expect(html).not.toContain('$227.78');
    expect(html).not.toContain('$243.72');
    expect(html).not.toContain('Estimated material profitability');
    expect(html).not.toContain('Estimated factory rate');
    expect(html).not.toContain('Production cost');
    expect(html).toContain('Product Details');
    expect(html).toContain('Frame Color: Bronze');
    expect(html).toContain('Unit Price');
    expect(html).toContain('Subtotal');
    expect(html).not.toContain('Regular');
    expect(html).not.toContain('50% OFF');
  });

  it('renders external dealer service prices for the customer while hiding company cost', () => {
    const html = EstimatePdfHtmlBuilder.build(
      withExternalDealerCustomerCharges(),
      'dealer_public',
    );

    expect(html).toContain('$650.00');
    expect(html).toContain('$175.00');
    expect(html).toContain('$1,100.00');
    expect(html).toContain('$75.00');
    expect(html).toContain('$300.00');
    expect(html).toContain('$2,580.29');
    expect(html).not.toContain('$400.00');
    expect(html).not.toContain('$125.00');
    expect(html).not.toContain('$1,000.00');
    expect(html).not.toContain('Dealer-created');
  });

  it('shows both company cost and customer price in the external dealer PDF', () => {
    const html = EstimatePdfHtmlBuilder.build(
      withExternalDealerCustomerCharges(),
      'dealer_internal',
    );

    expect(html).toContain('Dealer Cost');
    expect(html).toContain('Customer Price');
    expect(html).toContain('$400.00');
    expect(html).toContain('$650.00');
    expect(html).toContain('Dealer-created');
    expect(html).toContain('$2,580.29');
  });

  it('hides an unused system charge from customer PDFs but keeps it in the dealer comparison', () => {
    const estimate = withExternalDealerCustomerCharges();
    const cityFee = estimate.customerChargesSummary?.lines.find(
      (line) => line.source === 'CITY_FEE',
    );
    if (!cityFee || !estimate.customerChargesSummary) {
      throw new Error('City Fee fixture is missing.');
    }
    cityFee.usedInCustomerQuote = false;
    estimate.customerChargesSummary.customerTotal = '2225.00';

    const customerHtml = EstimatePdfHtmlBuilder.build(
      estimate,
      'dealer_public',
    );
    const dealerHtml = EstimatePdfHtmlBuilder.build(
      estimate,
      'dealer_internal',
    );

    expect(customerHtml).not.toContain('City Fee');
    expect(customerHtml).not.toContain('$75.00');
    expect(customerHtml).toContain('$2,505.29');
    expect(dealerHtml).toContain('City Fee');
    expect(dealerHtml).toContain('Not used');
  });

  it('uses one customer total without itemized service prices in the total-only PDF', () => {
    const html = EstimatePdfHtmlBuilder.build(
      withExternalDealerCustomerCharges(),
      'dealer_public_total',
    );

    expect(html).toContain('Project scope');
    expect(html).toContain('Remove shutters');
    expect(html).toContain('$2,580.29');
    expect(html).not.toContain('$650.00');
    expect(html).not.toContain('$175.00');
    expect(html).not.toContain('$1,100.00');
    expect(html).not.toContain('$75.00');
    expect(html).not.toContain('$300.00');
  });

  it('supports dealer-created installation prices without company installation', () => {
    const estimate = estimateFixture(false);
    estimate.customerChargesSummary = {
      enabled: true,
      systemTotal: '0.00',
      customerTotal: '2400.00',
      knownSystemMargin: '0.00',
      dealerCreatedTotal: '2400.00',
      systemTotalIncomplete: false,
      customerTotalIncomplete: false,
      lines: [
        {
          id: 10,
          origin: 'DEALER',
          source: 'CUSTOM',
          sourceKey: null,
          sourceRefId: null,
          description: 'Installation',
          systemAmount: null,
          customerAmount: '2000.00',
          pricingMode: 'FINAL',
          pricingValue: '2000.0000',
          usedInCustomerQuote: true,
          needsReview: false,
          sortOrder: 1000,
        },
        {
          id: 11,
          origin: 'DEALER',
          source: 'CUSTOM',
          sourceKey: null,
          sourceRefId: null,
          description: 'Remove shutters',
          systemAmount: null,
          customerAmount: '400.00',
          pricingMode: 'FINAL',
          pricingValue: '400.0000',
          usedInCustomerQuote: true,
          needsReview: false,
          sortOrder: 1010,
        },
      ],
    };

    const html = EstimatePdfHtmlBuilder.build(estimate, 'dealer_public');

    expect(html).toContain('Installation');
    expect(html).toContain('$2,000.00');
    expect(html).toContain('Remove shutters');
    expect(html).toContain('$400.00');
    expect(html).toContain('$2,680.29');
    expect(html).not.toContain('Not included');
  });

  it('assigns an internal Impact dealer customer margin to Impact in the admin PDF', () => {
    const estimate = estimateFixture();
    Object.assign(estimate, {
      dealerModeSnapshot: 'INTERNAL',
      dealerAffiliationSnapshot: 'IMPACT',
    });

    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin');

    expect(html).toContain('INTERNAL · IMPACT');
    expect(html).toMatch(
      /<span>Estimated Impact profit<\/span>\s*<span>\$34\.17<\/span>/,
    );
    expect(html).toMatch(
      /<span>Estimated Authentic profit<\/span>\s*<span>\$0\.00<\/span>/,
    );
    expect(html).toMatch(
      /<span>Estimated total company profit<\/span>\s*<span>\$34\.17<\/span>/,
    );
    expect(html).not.toContain('Dealer profit');
  });

  it('assigns an internal Authentic dealer customer margin to Authentic in the admin PDF', () => {
    const estimate = estimateFixture();
    Object.assign(estimate, {
      dealerModeSnapshot: 'INTERNAL',
      dealerAffiliationSnapshot: 'AUTHENTIC',
    });

    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin');

    expect(html).toContain('INTERNAL · AUTHENTIC');
    expect(html).toMatch(
      /<span>Estimated Impact profit<\/span>\s*<span>\$0\.00<\/span>/,
    );
    expect(html).toMatch(
      /<span>Estimated Authentic profit<\/span>\s*<span>\$34\.17<\/span>/,
    );
  });

  it('assigns an external Impact dealer estimate margin to Impact in the admin PDF', () => {
    const estimate = estimateFixture();
    Object.assign(estimate, {
      dealerModeSnapshot: 'EXTERNAL',
      dealerAffiliationSnapshot: 'IMPACT',
    });

    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin');

    expect(html).toContain('EXTERNAL · IMPACT');
    expect(html).toMatch(
      /<span>Estimated Impact profit<\/span>\s*<span>\$29\.71<\/span>/,
    );
    expect(html).toMatch(
      /<span>Estimated Authentic profit<\/span>\s*<span>\$0\.00<\/span>/,
    );
  });

  it('assigns an external Authentic dealer estimate margin to Authentic in the admin PDF', () => {
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin');

    expect(html).toContain('EXTERNAL · AUTHENTIC');
    expect(html).toMatch(
      /<span>Estimated Impact profit<\/span>\s*<span>\$0\.00<\/span>/,
    );
    expect(html).toMatch(
      /<span>Estimated Authentic profit<\/span>\s*<span>\$29\.71<\/span>/,
    );
  });

  it('omits the installation section when there is no installation', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(false),
      'dealer_public',
    );

    expect(html).not.toContain('Installation &amp; services');
    expect(html).not.toContain('Not included');
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
    expect(html).not.toContain('Estimated factory rate');
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
    expect(html).not.toContain('Unit Price');
    expect(html).not.toContain('Material subtotal');
    expect(html).not.toContain('Sales Tax');
    expect(html).not.toContain('$261.95');
    expect(html).not.toContain('$125.00');
    expect(html).not.toContain('$1,000.00');
  });

  it('omits an empty scope section in a project-total PDF', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(false),
      'dealer_public_total',
    );

    expect(html).not.toContain('Installation');
    expect(html).not.toContain('Not included');
    expect(html).toContain('Project Total');
    expect(html).toContain('$280.29');
    expect(html).not.toContain('Additional services');
    expect(html).not.toContain('Permit service');
  });

  it('keeps complete product cards together when printing', () => {
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin');

    expect(html).toContain('.product-card');
    expect(html).toContain('break-inside: avoid-page !important;');
    expect(html).toContain('page-break-inside: avoid !important;');
    expect(html).toContain('Estimated material profitability');
    expect(html).toContain('Estimated factory rate');
  });

  it('embeds a captured diagram in its matching product card', () => {
    const diagram = 'data:image/png;base64,ZmFrZQ==';
    const html = EstimatePdfHtmlBuilder.build(estimateFixture(), 'admin', {
      '77': diagram,
    });

    expect(html).toContain(diagram);
    expect(html).toContain('alt="Diagram for F1"');
    expect(html).toContain(
      '<div class="diagram-column"><div class="mark-badge">F1</div><div class="diagram-frame">',
    );
    expect(html).not.toContain('Diagram unavailable');
  });

  it('uses green final-price styling without adding discount copy', () => {
    const html = EstimatePdfHtmlBuilder.build(
      estimateFixture(),
      'dealer_public',
    );

    expect(html).toContain(
      '<div class="price-block subtotal-block price-success">',
    );
    expect(html).toContain(
      '<div class="project-total project-total-success keep-together">',
    );
    expect(html).toContain('Product illustrations are visual references');
    expect(html).not.toContain('50% OFF');
    expect(html).not.toContain('Regular material price');
  });

  it('does not invent a company name when branding is missing', () => {
    const estimate = estimateFixture();
    estimate.branding = null;

    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin');

    expect(html).not.toContain('<div class="brand-name">Impact Plus</div>');
    expect(html).toContain('<div class="logo-wrap"></div>');
  });

  it('uses the item number when a product mark is empty', () => {
    const estimate = estimateFixture();
    estimate.pieces[0].mark = ' ';
    const diagram = 'data:image/png;base64,ZmFrZQ==';
    const html = EstimatePdfHtmlBuilder.build(estimate, 'admin', {
      '77': diagram,
    });

    expect(html).toContain('<div class="mark-badge">#1</div>');
    expect(html).toContain('alt="Diagram for #1"');
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

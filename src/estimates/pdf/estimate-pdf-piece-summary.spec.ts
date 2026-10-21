import type { EstimateWithRelations, PdfView } from '../estimates.service';
import { EstimatePdfHtmlBuilder } from './estimate-pdf-html.builder';

const pieceFixture = (id = 1, qty = 3, dealerMarkup: unknown = '0.25') => ({
  id,
  mark: `W${id}`,
  qty,
  width: 36,
  height: 60,
  prod: { name: 'Single Hung', kind: 'GLAZED_UNIT' },
  bran: { name: 'Eco' },
  syst: { name: '100' },
  conf: { conf: 'Equal Lites' },
  fColor: { color: 'White' },
  cryst: { glass: '7/16 Laminated' },
  tin: { color: 'Clear' },
  price: '100',
  subtotal: String(100 * qty),
  customerPrice: '125',
  customerSubtotal: String(125 * qty),
  dealerMarkup,
});

const estimateFixture = () => ({
  id: 10,
  idUser: 7,
  number: 190920,
  name: 'Piece summary example',
  date: new Date('2026-10-21T12:00:00Z'),
  priceT: '700',
  customerPriceT: '824.36',
  taxRate: '0',
  customerTaxRate: '0',
  taxAmount: '0',
  customerTaxAmount: '0',
  totalPayable: '700',
  customerTotalPayable: '824.36',
  rateT: '560',
  netProfit: '140',
  netProfitD: '124.36',
  dealerModeSnapshot: 'EXTERNAL',
  status: { name: 'Active' },
  user: {
    id: 7,
    firstName: 'Example',
    lastName: 'Dealer',
    role: { name: 'dealer' },
    dealerMode: 'EXTERNAL',
  },
  branding: { name: 'Example Windows' },
  installationSummary: null,
  pieces: [pieceFixture(), {
    ...pieceFixture(2, 4, '0.1234'),
    prod: { name: 'Mullion', kind: 'LINEAR_MATERIAL' },
    customerPrice: '112.34',
    customerSubtotal: '449.36',
  }],
});

const build = (
  estimate: ReturnType<typeof estimateFixture>,
  view: PdfView = 'admin',
  viewerRole = 'admin',
) => EstimatePdfHtmlBuilder.build(
  estimate as unknown as EstimateWithRelations, view, {}, 7, viewerRole,
);
const productCards = (html: string) =>
  [...html.matchAll(/<article class="product-card">[\s\S]*?<\/article>/g)]
    .map(match => match[0]);
const plainText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const breakdownOffset = (html: string) => html.search(/class="pieces-breakdown(?:\s[^"]*)?"/);
const breakdown = (html: string) => {
  const start = breakdownOffset(html);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('Project Summary', start));
};

describe('PDF piece quantities and markup visibility', () => {
  it.each<PdfView>(['admin', 'dealer_internal', 'dealer_public', 'dealer_public_total', 'client'])(
    'includes the quantity breakdown after products and before prices in the %s view',
    view => {
      const estimate = estimateFixture();
      const before = JSON.stringify(estimate);
      const html = build(estimate, view);
      const summary = breakdown(html);
      expect(plainText(summary)).toMatch(/Pieces Breakdown\s+Qty\s+7\b/);
      expect(plainText(summary)).toContain('Single Hung: 3 | Mullion: 4');
      expect(productCards(html)).toHaveLength(2);
      expect(breakdownOffset(html)).toBeGreaterThan(html.lastIndexOf('</article>'));
      expect(breakdownOffset(html)).toBeLessThan(html.indexOf('Project Summary'));
      expect(JSON.stringify(estimate)).toBe(before);
    },
  );

  it('combines repeated product quantities by trimmed name and uses a fallback for unnamed products', () => {
    const estimate = estimateFixture();
    estimate.pieces.push(
      { ...pieceFixture(3, 2), prod: { name: ' Single Hung ', kind: 'GLAZED_UNIT' } },
      { ...pieceFixture(4, 1), prod: { name: '', kind: 'GLAZED_UNIT' } },
    );
    const summary = plainText(breakdown(build(estimate)));
    expect(summary).toMatch(/Qty\s+10\b/);
    expect(summary).toContain('Single Hung: 5 | Mullion: 4 | Product: 1');
    expect(summary.match(/Single Hung:/g)).toHaveLength(1);
  });

  it('escapes product names in the new breakdown', () => {
    const estimate = estimateFixture();
    estimate.pieces[0].prod.name = '<img src=x onerror="alert(1)"> & Windows';
    const summary = breakdown(build(estimate));
    expect(summary).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Windows: 3');
    expect(summary).not.toContain('<img src=x');
  });

  it('shows zero quantity and the existing empty state when there are no pieces', () => {
    const estimate = estimateFixture();
    estimate.pieces = [];
    const html = build(estimate);
    expect(plainText(breakdown(html))).toMatch(/Qty\s+0\b/);
    expect(html).toContain('No products included.');
    expect(html).toContain('No calculated pieces yet.');
  });

  it.each([
    ['admin', 'admin'],
    ['admin', 'operator'],
    ['dealer_internal', 'dealer'],
  ] as const)('shows each stored markup in the %s view for %s', (view, role) => {
    const cards = productCards(build(estimateFixture(), view, role));
    expect(cards[0]).toContain('>Markup<');
    expect(cards[0]).toContain('25.00%');
    expect(cards[1]).toContain('>Markup<');
    expect(cards[1]).toContain('12.34%');
    expect(cards[0]).toContain('$100.00');
    expect(cards[0]).toContain('$300.00');
    expect(cards[1]).toContain('$400.00');
  });

  it.each<PdfView>(['dealer_public', 'dealer_public_total', 'client'])(
    'never shows markup in the %s customer view, even when an admin generates it',
    view => {
      for (const mode of ['INTERNAL', 'EXTERNAL']) {
        const estimate = estimateFixture();
        estimate.dealerModeSnapshot = mode;
        estimate.user.dealerMode = mode;
        const html = build(estimate, view, 'admin');
        expect(html).not.toContain('>Markup<');
        expect(productCards(html).join('')).not.toMatch(/25\.00%|12\.34%|dealerMarkup/i);
        if (view === 'dealer_public_total') {
          expect(productCards(html).join('')).not.toMatch(/Unit Price|Subtotal|\$125\.00/);
        }
      }
    },
  );

  it.each<PdfView>(['admin', 'dealer_internal'])(
    'does not label client-owned pieces with dealer markup in the %s view',
    view => {
      const estimate = estimateFixture();
      estimate.user.role.name = 'client';
      expect(productCards(build(estimate, view)).join('')).not.toMatch(/>Markup<|25\.00%|12\.34%/);
    },
  );

  it('distinguishes a saved zero markup from unavailable or invalid values', () => {
    const estimate = estimateFixture();
    estimate.pieces = [pieceFixture(1, 1, 0)];
    expect(productCards(build(estimate))[0]).toContain('0.00%');
    for (const unavailable of [null, undefined, 'NaN', Infinity]) {
      estimate.pieces[0].dealerMarkup = unavailable;
      const card = productCards(build(estimate))[0];
      expect(plainText(card)).toMatch(/Markup\s+—/);
      expect(card).not.toMatch(/0\.00%|NaN%|Infinity%/);
    }
  });
});

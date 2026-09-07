import Decimal from 'decimal.js';
import {
  applyPromotion,
  effectiveExpiry,
  promotionDeadline,
  promotionExpired,
  savedPromotions,
  checkoutPromotionExpiry,
  PromotionTerms,
} from './promotion-pricing';
import { EstimatePieceCalculatorService } from '@/estimates/calculation/estimate-piece-calculator.service';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
const offer = (
  percent = '20',
  fields: Partial<PromotionTerms> = {},
): PromotionTerms => ({
  id: 1,
  version: 1,
  name: 'Offer',
  percent,
  startsAt: '2026-09-01T00:00:00Z',
  endsAt: '2026-10-01T00:00:00Z',
  brandId: null,
  productId: null,
  systemId: null,
  ...fields,
});
const piece = () => ({
  idBrand: 1,
  idProd: 2,
  idSyst: 3,
  qty: 3,
  price: new Decimal('100'),
  customerPrice: new Decimal('120'),
  rate: new Decimal('90'),
  subtotal: new Decimal('300'),
  customerSubtotal: new Decimal('360'),
  netProfit: new Decimal('10'),
  netProfitD: new Decimal('60'),
  dealerMarkupDecimal: new Decimal('.2'),
});
describe('Material promotions', () => {
  it('preserves regular pricing exactly when no promotion applies', () => {
    const p = piece();
    const r = applyPromotion(p, []);
    expect(r.price).toBe(p.price);
    expect(r.netProfitD).toBe(p.netProfitD);
    expect(r.promotionSnapshot).toBeNull();
  });
  it('matches all configured piece filters together', () => {
    const r = applyPromotion(piece(), [
      offer('40', { brandId: 1, productId: 9 }),
      offer('15', { brandId: 1, productId: 2, systemId: 3 }),
    ]);
    expect(r.price.toString()).toBe('85');
  });
  it('uses the largest eligible discount without stacking', () => {
    expect(
      applyPromotion(piece(), [
        offer('20'),
        offer('30', { id: 2 }),
      ]).price.toString(),
    ).toBe('70');
  });
  it('supports discounts below cost without a floor', () => {
    const r = applyPromotion(piece(), [offer('40')]);
    expect(r.price.toString()).toBe('60');
    expect(r.netProfit.toString()).toBe('-30');
  });
  it('supports 100 percent and keeps the original prices', () => {
    const r = applyPromotion(piece(), [offer('100')]);
    expect(r.subtotal.toString()).toBe('0');
    expect(r.regularPrice.toString()).toBe('100');
  });
  it('calculates tax on discounted material totals', () => {
    const r = applyPromotion(piece(), [offer()]);
    const calc = new EstimatePieceCalculatorService({} as any, {} as any);
    const t = calc.calculateEstimateTotals(
      [r as any],
      new Decimal('.07'),
      new Decimal('.07'),
    );
    expect(t.priceT.toString()).toBe('240');
    expect(t.taxAmount.toString()).toBe('16.8');
    expect(t.discountAmount.toString()).toBe('60');
    expect(t.customerDiscountAmount.toString()).toBe('72');
    expect(t.netProfitD.toString()).toBe('48');
  });
  it('applies promotion, then the additional discount, then tax to the remaining materials', () => {
    const p = {
      ...piece(),
      qty: 1,
      price: new Decimal('154.36'),
      subtotal: new Decimal('154.36'),
    };
    const promoted = applyPromotion(p, [offer('35')]);
    const calc = new EstimatePieceCalculatorService({} as any, {} as any);
    const totals = calc.calculateEstimateTotals(
      [promoted as any],
      new Decimal('.07'),
      new Decimal('.07'),
    );
    expect(totals.priceT.toFixed(2)).toBe('100.33');
    expect(totals.discountAmount.toFixed(2)).toBe('54.03');
    expect(totals.taxAmount.toFixed(2)).toBe('7.02');
    const final = calculateEstimateDiscount({
      ...totals,
      taxRate: '.07',
      dealerModeSnapshot: 'EXTERNAL',
      manualDiscount: { scope: 'MATERIAL', type: 'AMOUNT', value: '20' },
    });
    expect(final).toMatchObject({
      base: '100.33',
      discount: '20.00',
      projectTotal: '85.95',
      material: { subtotal: '80.33', netDiscount: '20.00', tax: '5.62' },
    });
  });
  it('rounds unit prices before multiplying quantity', () => {
    const p = piece();
    p.price = new Decimal('10.03');
    expect(applyPromotion(p, [offer('15')]).subtotal.toString()).toBe('25.59');
  });
  it('uses the earliest promotion actually applied', () => {
    const first = offer('10', { endsAt: '2026-09-10T12:00:00Z' });
    expect(
      promotionDeadline([
        { promotionSnapshot: first },
        { promotionSnapshot: offer() },
      ])?.toISOString(),
    ).toBe(first.endsAt.replace('Z', '.000Z'));
  });
  it('never extends an earlier ordinary estimate expiry', () => {
    expect(
      effectiveExpiry(
        new Date('2026-09-08'),
        new Date('2026-09-10'),
      )?.toISOString(),
    ).toContain('2026-09-08');
  });
  it('requires recalculate exactly at expiry for unpaid quotes', () => {
    const e = { promotionExpiresAt: '2026-09-10T12:00:00Z' };
    expect(promotionExpired(e, Date.parse(e.promotionExpiresAt))).toBe(true);
  });
  it('preserves paid promotion terms through expiry and revisions', () => {
    const e = {
      promotionContext: [offer()],
      promotionExpiresAt: '2026-10-01',
      promotionLockedAt: new Date('2026-09-10'),
    };
    expect(promotionExpired(e, Date.parse('2026-11-01'))).toBe(false);
    expect(savedPromotions(e, Date.parse('2026-11-01'))).toHaveLength(1);
  });
  it('does not preserve an unpaid offer merely because a checkout existed', () => {
    expect(
      savedPromotions(
        { promotionContext: [offer()] },
        Date.parse('2026-11-01'),
      ),
    ).toHaveLength(0);
  });
  it('expires Stripe sessions no later than the promotion', () => {
    const end = '2026-09-10T13:00:00Z';
    expect(
      checkoutPromotionExpiry(
        { promotionExpiresAt: end },
        Date.parse('2026-09-10T12:00:00Z'),
      ),
    ).toBe(Date.parse(end) / 1000);
  });
  it('rejects a new session too close to expiry but leaves non-promotional checkout unchanged', () => {
    expect(() =>
      checkoutPromotionExpiry(
        { promotionExpiresAt: '2026-09-10T12:10:00Z' },
        Date.parse('2026-09-10T12:00:00Z'),
      ),
    ).toThrow();
    expect(checkoutPromotionExpiry({})).toBeUndefined();
  });
});

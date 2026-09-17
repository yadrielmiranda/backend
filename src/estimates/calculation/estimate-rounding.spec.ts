import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { EstimatePieceCalculatorService } from './estimate-piece-calculator.service';
import { calculateEstimateDiscount } from '../discounts/estimate-discount';

// Calculador real con catálogo aislado, sin consultar una base de datos.
function fixture(linear = false, cost = '99.4444') {
  const service = new EstimatePieceCalculatorService({
    computeGoverningDimsFromConfig: jest.fn(async () => ({ widthIn: 36, heightIn: 48 })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  } as any, { normalizePieceMuntinFromCatalog: jest.fn(async () => null) } as any);
  const cache = service.createCalculationCache();
  cache.product.set(1, { id: 1, isActive: true, kind: linear ? 'LINEAR_MATERIAL' : 'GLAZED_UNIT', pricingMode: linear ? 'LINEAR_INCH' : 'AREA_PERIMETER' });
  cache.config.set(1, { conf: 'Fixed', requiresWidth: true, requiresHeight: !linear, fixedPanelCount: null } as any);
  cache.sysConf.set('1-1', { isSelectableInEstimate: true, dimensionMode: 'STANDARD', activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] });
  cache.systemFrameColor.set('1-1', {});
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  cache.linearPricing.set('1-1-1-1', { costPerInch: cost, minLengthIn: '0.125', maxLengthIn: '200' });
  const tx: any = {
    pricingRangeRule: { findMany: jest.fn(async () => []) },
    pricingRule: { findUnique: jest.fn(async () => ({ costoA: '0', costoB: '0', costoC: cost })) },
  };
  const calculate = (qty = 3, markup = 25) => service.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    ...(linear ? {} : { idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1, height: '48' }),
    width: linear ? '1' : '36', qty, dealerMarkup: markup, mark: 'A',
  } as any, new Decimal('.2'), tx, cache);
  const totals = (pieces: any[]) => service.calculateEstimateTotals(pieces, new Decimal('.07'), new Decimal('.07'));
  return { service, cache, calculate, totals };
}

describe('H08 — Unit prices, subtotals and dealer profit', () => {
  it.each([false, true])('uses the displayed unit price for qty 3 (linear: %s)', async linear => {
    const f = fixture(linear);
    const piece = await f.calculate();
    expect(piece.price.toFixed(2)).toBe('119.33');
    expect(piece.customerPrice.toFixed(2)).toBe('149.16');
    expect(piece.subtotal.toFixed(2)).toBe('357.99');
    expect(piece.customerSubtotal.toFixed(2)).toBe('447.48');
    expect(piece.netProfitD.toFixed(2)).toBe('89.49');
    const totals = f.totals([piece]);
    expect(totals.customerPriceT.toFixed(2)).toBe('447.48');
    expect(totals.netProfitD.toFixed(2)).toBe('89.49');
    expect(totals.customerTaxAmount.toFixed(2)).toBe('31.32');
    expect(totals.customerTotalPayable.toFixed(2)).toBe('478.80');
    const persisted = f.service.calculateEstimateTotalsFromPersistedPieces([{
      ...piece, rate: new Prisma.Decimal(piece.rate.toString()), price: new Prisma.Decimal(piece.price.toString()),
      customerPrice: new Prisma.Decimal(piece.customerPrice.toString()), dealerMarkup: new Prisma.Decimal('.25'),
    }], new Decimal('.07'), new Decimal('.07'));
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(totals));
  });

  it.each([1, 3, 7, 137])('keeps both product kinds and multiple lines consistent for qty %s', async qty => {
    const f = fixture();
    const linear = fixture(true, '88.895');
    const pieces = [await f.calculate(qty, 17.37), await linear.calculate(qty, 25)];
    const totals = f.totals(pieces);
    expect(totals.customerPriceT.toString()).toBe(pieces.reduce((sum, p) => sum.add(p.customerSubtotal), new Decimal(0)).toString());
    expect(totals.netProfitD.toString()).toBe(totals.customerPriceT.minus(totals.priceT).toString());
    expect(totals.netProfit.toString()).toBe(pieces.reduce((sum, p) => sum.add(p.netProfit.mul(p.qty)), new Decimal(0)).toString());
    expect(totals.customerTotalPayable.toString()).toBe(totals.customerPriceT.add(totals.customerTaxAmount).toString());
  });

  it.each([0, 17.5, 100])('retains consistent subtotals and profits with a %s percent promotion', async percent => {
    const f = fixture();
    f.cache.promotions = percent ? [{ id: 1, version: 1, name: 'Offer', percent: String(percent), startsAt: '2026-01-01', endsAt: '2099-01-01', brandId: null, productId: null, systemId: null }] : [];
    const piece = await f.calculate(7);
    const totals = f.totals([piece]);
    expect(piece.customerSubtotal.eq(piece.customerPrice.mul(7))).toBe(true);
    expect(totals.customerPriceT.toString()).toBe(piece.customerSubtotal.toString());
    expect(totals.netProfitD.toString()).toBe(piece.netProfitD.toString());
    expect(totals.netProfitD.eq(totals.customerPriceT.minus(totals.priceT))).toBe(true);
    expect(totals.customerDiscountAmount.toString()).toBe(piece.regularCustomerPrice!.mul(7).minus(piece.customerSubtotal).toString());
  });

  it('calculates tax from the rounded material subtotal after a manual discount', async () => {
    const f = fixture();
    const piece = await f.calculate();
    const totals = f.totals([piece]);
    const discounted = calculateEstimateDiscount({ ...totals, dealerModeSnapshot: 'INTERNAL',
      manualDiscount: { scope: 'MATERIAL', type: 'AMOUNT', value: '20', materialDiscountBasis: 'BEFORE_TAX' },
    } as any);
    expect(discounted?.discount).toBe('20.00');
    expect(discounted?.material.subtotal).toBe('427.48');
    expect(discounted?.material.tax).toBe('29.92');
    expect(discounted?.material.total).toBe('457.40');
    expect(totals.customerTotalPayable.toFixed(2)).toBe('478.80');
  });
});

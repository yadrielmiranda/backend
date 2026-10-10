import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { EstimatePieceCalculatorService } from './estimate-piece-calculator.service';

function fixture(axis: 'width' | 'height') {
  const service = new EstimatePieceCalculatorService({
    computeGoverningDimsFromConfig: jest.fn(async piece => ({ widthIn: piece.width, heightIn: piece.height })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  } as any, { normalizePieceMuntinFromCatalog: jest.fn(async () => null) } as any);
  const cache = service.createCalculationCache();
  cache.product.set(1, { id: 1, isActive: true, kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER' });
  cache.config.set(1, { conf: 'Fixed', requiresWidth: true, requiresHeight: true, fixedPanelCount: null } as any);
  cache.sysConf.set('1-1', { isSelectableInEstimate: true, dimensionMode: 'STANDARD', activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] });
  cache.systemFrameColor.set('1-1', {});
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  const bounds = {
    minWidthIn: null, maxWidthIn: null, minWidthInclusive: true, maxWidthInclusive: true,
    minHeightIn: null, maxHeightIn: null, minHeightInclusive: true, maxHeightInclusive: true,
  };
  const axisName = axis === 'width' ? 'Width' : 'Height';
  const tx: any = {
    pricingRangeRule: { findMany: jest.fn(async () => [
      {
        costoA: '0', costoB: '0', costoC: '100',
        range: { ...bounds, [`max${axisName}In`]: new Prisma.Decimal('67.0625') },
      },
      {
        costoA: '0', costoB: '0', costoC: '200',
        range: { ...bounds, [`min${axisName}In`]: new Prisma.Decimal('67.0625'), [`min${axisName}Inclusive`]: false },
      },
    ]) },
    pricingRule: { findUnique: jest.fn() },
  };
  const calculate = (value: string) => service.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '48', height: '48', [axis]: value, qty: 1, dealerMarkup: 0, mark: 'A',
  } as any, new Decimal(0), tx, cache);
  return { calculate, tx };
}

describe.each(['width', 'height'] as const)('Four-decimal pricing range %s boundary', axis => {
  it('selects the correct price below, at, and above 67.0625 without rounding or ambiguous matches', async () => {
    const { calculate, tx } = fixture(axis);
    expect((await calculate('67.0624')).rate.toFixed(2)).toBe('100.00');
    expect((await calculate('67.0625')).rate.toFixed(2)).toBe('100.00');
    expect((await calculate('67.0626')).rate.toFixed(2)).toBe('200.00');
    expect((await calculate('67.0625')).rate.toFixed(2)).toBe('100.00');
    expect(tx.pricingRule.findUnique).not.toHaveBeenCalled();
    expect(tx.pricingRangeRule.findMany).toHaveBeenCalledTimes(3);
  });
});

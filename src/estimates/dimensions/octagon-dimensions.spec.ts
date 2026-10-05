import Decimal from 'decimal.js';
import { BillableHeightMode, DimensionMode, DimensionRuleType } from '@prisma/client';
import { areaPerimeterFor } from '@/pricing/shape-geometry';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { EstimatePieceCalculatorService } from '../calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from '../muntins/estimate-muntin.service';
import { EstimateDimensionValidationService } from './estimate-dimension-validation.service';

function fixture(conf = 'Octagon', ratedHeight = 24, billing = {}) {
  // Real dimension validation and calculator; only catalog persistence is mocked.
  const dimensions = new EstimateDimensionValidationService();
  const calculator = new EstimatePieceCalculatorService(dimensions, new EstimateMuntinService());
  const config = { conf, requiresWidth: true, requiresHeight: false,
    requiresHeightLeft: false, requiresHeightRight: false, requiresLegHeight: false,
    requiresSashHeight: false, requiresWindowHeight: false, fixedPanelCount: null, muntinLayout: null };
  const sysConf = { isSelectableInEstimate: true, dimensionMode: DimensionMode.STANDARD,
    activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [], ...billing };
  const tx: any = {
    config: { findUnique: jest.fn(async () => config) },
    sysConf: { findUnique: jest.fn(async () => sysConf) },
    sysConfReinforcementOption: { findMany: jest.fn(async () => []) },
    dimensionPolicy: { findFirst: jest.fn(async () => ({
      roundingRule: 'ROUND_UP_TO_NEXT',
      rules: [{ ruleType: DimensionRuleType.MAIN, widthIn: 24, heightIn: ratedHeight,
        dpPosPsf: 70, dpNegPsf: -70 }],
    })) },
    pricingRangeRule: { findMany: jest.fn(async () => []) },
    pricingRule: { findUnique: jest.fn(async () => ({ costoA: '7', costoB: '3', costoC: '5' })) },
  };
  const cache = calculator.createCalculationCache();
  cache.product.set(1, { id: 1, isActive: true, kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER' });
  cache.config.set(8, config);
  cache.sysConf.set('1-8', sysConf);
  cache.systemFrameColor.set('1-1', {});
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  for (const [map, field] of [
    [cache.brandTint, 'tint'], [cache.brandCoating, 'coating'], [cache.brandPrivacy, 'privacy'],
  ] as const) map.set('1-1', { [field]: { isActive: true }, surchargeEnabled: false });
  const piece = (height?: string): CreatePieceDto => ({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 8, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '24', ...(height === undefined ? {} : { height }), qty: 1, mark: 'Octagon',
  });
  return { dimensions, calculator, tx, cache, piece };
}

describe('width-only Octagon dimensions', () => {
  it.each([undefined, '0'])('uses 24 x 24 for governing dimensions and precheck when height is %s', async height => {
    const f = fixture();
    await expect(f.dimensions.computeGoverningDimsFromConfig(f.piece(height), f.tx))
      .resolves.toEqual({ widthIn: 24, heightIn: 24 });
    await expect(f.dimensions.validateAgainstDimensionPolicy(f.piece(height), f.tx))
      .resolves.toMatchObject({ ok: true, dpPos: 70, dpNeg: -70, usedRange: { w: [24, 24], h: [24, 24] } });
    const result = await f.calculator.calculatePieceMetrics(f.piece(height), new Decimal(0), f.tx, f.cache);
    // Rectangular commercial formula: (2 * 2) * A + (2 + 2) * 2 * B + C.
    expect(result.rate.toFixed(2)).toBe('57.00');
    expect(f.tx.pricingRule.findUnique).toHaveBeenCalledWith({ where: {
      idBrand_idProduct_idSystem_idConfig_idCrystal: {
        idBrand: 1, idProduct: 1, idSystem: 1, idConfig: 8, idCrystal: 1,
      },
    } });
  });

  it.each([['Circle', 24], ['Half Circle', 12]] as const)('preserves %s derived height', async (conf, height) => {
    const f = fixture(conf, height);
    await expect(f.dimensions.computeGoverningDimsFromConfig(f.piece('0'), f.tx))
      .resolves.toEqual({ widthIn: 24, heightIn: height });
    await expect(f.dimensions.validateAgainstDimensionPolicy(f.piece('0'), f.tx))
      .resolves.toMatchObject({ ok: true, usedRange: { w: [24, 24], h: [height, height] } });
  });

  it.each([
    [{ minimumBillableWidthIn: '36', minimumBillableHeightIn: '48' }, '131.00'],
    [{ billableHeightMode: BillableHeightMode.WIDTH_PERCENTAGE, billableHeightPercentOfWidth: '50' }, '37.00'],
    [{ billableHeightMode: BillableHeightMode.FIXED, billableHeightFixedIn: '0', minimumBillableHeightIn: '48' }, '17.00'],
  ])('retains configured billing dimensions %j and A/B/C rates', async (billing, expectedRate) => {
    const f = fixture('Octagon', 24, billing);
    const result = await f.calculator.calculatePieceMetrics(f.piece(), new Decimal(0), f.tx, f.cache);
    expect(result.rate.toFixed(2)).toBe(expectedRate);
    expect(result.dpPosPsf.toFixed(2)).toBe('70.00');
    expect(result.dpNegPsf.toFixed(2)).toBe('-70.00');
  });

  it('keeps the existing rectangular area/perimeter convention for Octagon', () => {
    expect(areaPerimeterFor('Octagon', { width: 2, height: 2 }))
      .toEqual({ areaFt2: 4, perimeterFt: 8 });
  });
});

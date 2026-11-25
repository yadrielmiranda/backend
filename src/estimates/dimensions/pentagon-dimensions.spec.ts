import Decimal from 'decimal.js';
import { BillableHeightMode, DimensionMode, DimensionRuleType, Prisma } from '@prisma/client';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { EstimatePieceCalculatorService } from '../calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from '../muntins/estimate-muntin.service';
import { EstimateDimensionValidationService } from './estimate-dimension-validation.service';

function fixture(conf = 'Pentagon (Symmetric)') {
  const dimensions = new EstimateDimensionValidationService();
  const calculator = new EstimatePieceCalculatorService(dimensions, new EstimateMuntinService());
  const config = { conf, requiresWidth: true, requiresHeight: true, requiresLegHeight: true,
    requiresHeightLeft: false, requiresHeightRight: false, requiresSashHeight: false,
    requiresWindowHeight: false, fixedPanelCount: null, muntinLayout: null };
  const sysConf = { isSelectableInEstimate: true, dimensionMode: DimensionMode.STANDARD,
    billableHeightMode: BillableHeightMode.ACTUAL_HEIGHT,
    activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] };
  const tx: any = {
    config: { findUnique: jest.fn(async () => config) },
    sysConf: { findUnique: jest.fn(async () => sysConf) },
    sysConfReinforcementOption: { findMany: jest.fn(async () => []) },
    dimensionPolicy: { findFirst: jest.fn(async () => ({
      roundingRule: 'ROUND_UP_TO_NEXT',
      rules: [{ ruleType: DimensionRuleType.MAIN, widthIn: 48, heightIn: 60,
        dpPosPsf: 70, dpNegPsf: -70 }],
    })) },
    pricingRangeRule: { findMany: jest.fn(async () => [{
      // Approved V157 Pentagon range coefficients at 48 x 60 inches.
      costoA: '26.04863517232920616797', costoB: '9.05684735747896266638', costoC: '0',
      range: { code: 'N375PENTPVB_R027',
        minWidthIn: new Prisma.Decimal(48), maxWidthIn: new Prisma.Decimal(48),
        minHeightIn: new Prisma.Decimal(60), maxHeightIn: new Prisma.Decimal(60),
        minWidthInclusive: true, maxWidthInclusive: true,
        minHeightInclusive: true, maxHeightInclusive: true },
    }]) },
    pricingRule: { findUnique: jest.fn() },
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
  const piece = (legHeight: string, height = '60'): CreatePieceDto => ({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 8, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '48', height, legHeight, qty: 1, mark: conf,
  });
  return { dimensions, calculator, tx, cache, piece };
}

describe('symmetric pentagon leg height', () => {
  it.each(['24', '36', '59.875'])('keeps the rectangular V157 base price for a valid %s-inch leg', async legHeight => {
    const f = fixture(), piece = f.piece(legHeight);
    await expect(f.dimensions.computeGoverningDimsFromConfig(piece, f.tx))
      .resolves.toEqual({ widthIn: 48, heightIn: 60 });
    await expect(f.dimensions.validateAgainstDimensionPolicy(piece, f.tx))
      .resolves.toMatchObject({ ok: true });
    const calculated = await f.calculator.calculatePieceMetrics(piece, new Decimal(0), f.tx, f.cache);
    expect(calculated.rate.toFixed(2)).toBe('684.00');
    expect(f.tx.pricingRule.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['60', '60'], ['60.125', '60'], ['72', '60'],
    ['59.875', '59.875'], ['36', '24'],
  ])('rejects leg %s with height %s in precheck and calculation', async (legHeight, height) => {
    const f = fixture(), piece = f.piece(legHeight, height);
    const message = 'Leg Height must be less than Height.';
    await expect(f.dimensions.computeGoverningDimsFromConfig(piece, f.tx)).rejects.toThrow(message);
    await expect(f.dimensions.validateAgainstDimensionPolicy(piece, f.tx)).rejects.toThrow(message);
    await expect(f.calculator.calculatePieceMetrics(piece, new Decimal(0), f.tx, f.cache)).rejects.toThrow(message);
    expect(f.tx.pricingRangeRule.findMany).not.toHaveBeenCalled();
    expect(f.tx.pricingRule.findUnique).not.toHaveBeenCalled();
  });

  it('recognizes the configured name regardless of case or surrounding spaces', async () => {
    const f = fixture(' PENTAGON (SYMMETRIC) ');
    await expect(f.dimensions.computeGoverningDimsFromConfig(f.piece('60'), f.tx))
      .rejects.toThrow('Leg Height must be less than Height.');
  });

  it('keeps existing dimension handling for other configurations with a leg', async () => {
    const f = fixture('Eyebrow');
    await expect(f.dimensions.computeGoverningDimsFromConfig(f.piece('72'), f.tx))
      .resolves.toEqual({ widthIn: 48, heightIn: 72 });
  });
});

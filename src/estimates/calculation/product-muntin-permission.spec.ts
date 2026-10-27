import Decimal from 'decimal.js';
import { EstimatePieceCalculatorService } from './estimate-piece-calculator.service';
import { EstimateMuntinService } from '../muntins/estimate-muntin.service';

const fullView = { idPattern: 1, idType: null, panels: [] };
const grid = { idPattern: 2, idType: 7, panels: [{ panelIndex: 1, panelLabel: 'Glass', horizontalLites: 2, verticalLites: 3 }] };

function fixture(allowMuntin: boolean, mode = 'STANDARD', linear = false) {
  const normalizer = new EstimateMuntinService();
  const normalize = jest.spyOn(normalizer, 'normalizePieceMuntinFromCatalog');
  const calculator = new EstimatePieceCalculatorService({
    computeGoverningDimsFromConfig: jest.fn(async dto => ({ widthIn: Number(dto.width), heightIn: Number(dto.height) })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  } as any, normalizer);
  const cache = calculator.createCalculationCache();
  const product = { id: 1, isActive: true, allowMuntin, kind: linear ? 'LINEAR_MATERIAL' : 'GLAZED_UNIT', pricingMode: linear ? 'LINEAR_INCH' : 'AREA_PERIMETER' };
  cache.config.set(1, { conf: 'Fixed', requiresWidth: true, requiresHeight: !linear, fixedPanelCount: null,
    muntinLayout: [{ panelIndex: 1, panelLabel: 'Glass' }] } as any);
  cache.sysConf.set('1-1', { isSelectableInEstimate: true, dimensionMode: mode,
    requiresPanelCount: mode === 'WINDOW_WALL', requiresHorizontalHeights: mode === 'WINDOW_WALL',
    muntinAssignments: [{ ruleId: 1, idCrystal: 1, patternId: 2, rule: { availability: 'ALL', allowedTypes: [] } }],
    activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] });
  cache.systemFrameColor.set('1-1', {});
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  cache.linearPricing.set('1-1-1-1', { minLengthIn: '1', maxLengthIn: '200', costPerInch: '2' });
  const tx = {
    product: { findUnique: jest.fn(async () => product) },
    muntinPattern: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, inputMode: where.id === 1 ? 'NONE' : 'GRID', requiresType: where.id !== 1, isActive: true })) },
    muntinType: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, isActive: true })) },
    pricingRangeRule: { findMany: jest.fn(async () => []) },
    pricingRule: { findUnique: jest.fn(async () => ({ costoA: '0', costoB: '0', costoC: '100' })) },
  };
  const calculate = (muntin?: any) => calculator.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    ...(linear ? {} : { idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1 }),
    width: '48', height: '72', ...(mode === 'WINDOW_WALL' ? { panelCount: 2, horizontalHeights: [36] } : {}),
    qty: 2, mark: 'A', dealerMarkup: 10, muntin,
  } as any, new Decimal('.2'), tx as any, cache);
  return { calculate, tx, normalize, cache };
}

describe('Product allowMuntin in the shared calculator', () => {
  it.each(['STANDARD', 'WINDOW_WALL'])('ignores supplied muntins and Full View for disabled products in %s mode', async mode => {
    const f = fixture(false, mode);
    const baseline = await f.calculate();
    for (const supplied of [fullView, grid, { idPattern: 999, idType: 999, panels: [] }]) {
      const result = await f.calculate(supplied);
      expect(result.muntin).toBeNull();
      for (const key of ['rate', 'price', 'subtotal', 'customerPrice', 'customerSubtotal'] as const)
        expect(result[key].toString()).toBe(baseline[key].toString());
    }
    expect(baseline.muntin).toBeNull();
    expect(f.normalize).not.toHaveBeenCalled();
    expect(f.tx.muntinPattern.findUnique).not.toHaveBeenCalled();
    expect(f.tx.product.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ allowMuntin: true }) }));
  });

  it('keeps enabled Full View, configured grids and compatibility validation', async () => {
    const f = fixture(true);
    expect((await f.calculate(fullView)).muntin).toEqual(fullView);
    expect((await f.calculate(grid)).muntin).toMatchObject({ idPattern: 2, idType: 7, panels: [{ horizontalLites: 2, verticalLites: 3 }] });
    f.cache.sysConf.get('1-1').muntinAssignments = [];
    await expect(f.calculate(grid)).rejects.toThrow('not available');
  });

  it('clears stale muntins for disabled linear products before their validations', async () => {
    const f = fixture(false, 'STANDARD', true);
    const result = await f.calculate(grid);
    expect(result.muntin).toBeNull();
    expect(result.rate.toString()).toBe('96');
    expect(f.normalize).not.toHaveBeenCalled();
  });
});

import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { EstimatePieceCalculatorService } from './estimate-piece-calculator.service';

const sgp = '7/16 Lam [3/16 HS + .090 SGP + 3/16 HS]';
const boundedRule = (values: Record<string, unknown> = {}) => ({
  costoA: '144', costoB: '6', costoC: '100',
  range: {
    minWidthIn: new Prisma.Decimal('22.125'), maxWidthIn: new Prisma.Decimal('60'),
    minHeightIn: new Prisma.Decimal('72.125'), maxHeightIn: new Prisma.Decimal('108'),
    minWidthInclusive: true, maxWidthInclusive: true, minHeightInclusive: true, maxHeightInclusive: true,
  },
  ...values,
});

function fixture() {
  const dimensions = {
    computeGoverningDimsFromConfig: jest.fn(async piece => ({ widthIn: piece.width, heightIn: piece.height })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  };
  const calculator = new EstimatePieceCalculatorService(dimensions as any, {
    normalizePieceMuntinFromCatalog: jest.fn(async () => null),
  } as any);
  const cache = calculator.createCalculationCache();
  const product = { id: 1, isActive: true, allowMuntin: false, kind: 'GLAZED_UNIT',
    pricingMode: 'AREA_PERIMETER', diagramFamily: 'PIVOT_DOOR' };
  const config: any = { conf: 'O/X', requiresWidth: true, requiresHeight: true, fixedPanelCount: null };
  const sysConf: any = { isSelectableInEstimate: true, dimensionMode: 'ECO_WINDOWS_DOOR',
    requiresWidth: true, requiresHeight: true, requiresDoorHeight: true,
    activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] };
  cache.product.set(1, product);
  cache.config.set(1, config);
  cache.sysConf.set('1-1', sysConf);
  cache.systemFrameColor.set('1-1', { modifierEnabled: false });
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  const catalog = {
    crystal: { glass: sgp },
    system: { name: 'Serie 1500', idBrand: 1, idProduct: 1,
      brandProduct: { brand: { name: 'Eco Windows Systems' } } },
  };
  const tx: any = {
    product: { findUnique: jest.fn(async () => product) },
    systemCrystal: { findUnique: jest.fn(async () => catalog) },
    pricingRangeRule: { findMany: jest.fn(async () => [boundedRule()]) },
    pricingRule: { findUnique: jest.fn() },
  };
  const calculate = (overrides: Record<string, unknown> = {}, markup = '0') => calculator.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '45', height: '100', doorHeight: '80', qty: 1, dealerMarkup: 0, mark: 'Pivot', ...overrides,
  } as any, new Decimal(markup), tx, cache);
  return { calculate, cache, tx, dimensions, product, config, sysConf, catalog };
}

describe('Reviewed Pivot Serie 1500 O/X SGP door-dimension pricing', () => {
  it('uses door width/height for lookup and area/perimeter while retaining opening dimensions for validation', async () => {
    const f = fixture();
    f.cache.product.clear(); // Exercise the real product lookup, including its family.
    const result = await f.calculate({ height: '116', doorWidth: '60' });
    expect(result.rate.toFixed(2)).toBe('3825.00'); // 45*80 + 45+80 + 100; hidden Door Width is ignored.
    expect(result.width).toBe('45');
    expect(result.height).toBe('116');
    expect(result.doorHeight).toBe('80');
    expect(f.tx.product.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ diagramFamily: true }),
    }));
    expect(f.dimensions.validateAgainstDimensionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ width: '45', height: '116', doorHeight: '80' }), f.tx,
    );
    expect(f.tx.pricingRule.findUnique).not.toHaveBeenCalled();
  });

  it('matches the reviewed coefficient precision without charging the transom again', async () => {
    const f = fixture();
    f.tx.pricingRangeRule.findMany.mockResolvedValue([boundedRule({
      costoA: '47.424200479058925', costoB: '238.07022223821843', costoC: '225.12165202923114',
    })]);
    expect((await f.calculate()).rate.toFixed(2)).toBe('6370.52');
    expect((await f.calculate({ height: '116' })).rate.toFixed(2)).toBe('6370.52');
    expect(f.tx.systemCrystal.findUnique).toHaveBeenCalledTimes(1);
  });

  it('selects adjacent bands by Door Height with the supplied inclusive/exclusive boundary', async () => {
    const f = fixture();
    const first = boundedRule({ costoA: '0', costoB: '20.62000903298798', costoC: '5203.883603778508' });
    first.range.maxHeightIn = new Prisma.Decimal('75.75');
    const next = boundedRule({ costoA: '0', costoB: '54.84774193548372', costoC: '4713.188387096779' });
    next.range.minHeightIn = new Prisma.Decimal('75.75');
    next.range.minHeightInclusive = false;
    next.range.maxHeightIn = new Prisma.Decimal('78.75');
    f.tx.pricingRangeRule.findMany.mockResolvedValue([first, next]);
    expect((await f.calculate({ width: '40', doorHeight: '75.75' })).rate.toFixed(2)).toBe('5601.68');
    expect((await f.calculate({ width: '40', doorHeight: '75.875' })).rate.toFixed(2)).toBe('5772.44');
  });

  it.each(['92', '116'])('includes the 12- and 36-inch transom boundaries (opening %s)', async height => {
    expect((await fixture().calculate({ height })).rate.toFixed(2)).toBe('3825.00');
  });

  it.each(['91.875', '116.125'])('rejects a transom outside the reviewed domain (opening %s)', async height => {
    const f = fixture();
    await expect(f.calculate({ height })).rejects.toThrow('between 12 and 36 inches, inclusive');
    expect(f.tx.pricingRangeRule.findMany).not.toHaveBeenCalled();
  });

  it('requires Door Height even if its catalog input requirement is accidentally disabled', async () => {
    const f = fixture();
    f.sysConf.requiresDoorHeight = false;
    await expect(f.calculate({ doorHeight: undefined })).rejects.toThrow('Door Height is required for Serie 1500 O/X pricing');
  });

  it('preserves full-opening glass surcharges and downstream modifiers, markup and quantity', async () => {
    const f = fixture();
    Object.assign(f.cache.systemFrameColor.get('1-1'), { modifierEnabled: true, basePriceMultiplier: '2', basePriceDeduction: '10' });
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '2', costoB: '0', costoC: '0' });
    const result = await f.calculate({ qty: 2, dealerMarkup: 20 }, '.1');
    expect(result.rate.toFixed(2)).toBe('7702.50'); // 3825*2-10 + 45*100/144*2.
    expect(result.price.toFixed(2)).toBe('8472.75');
    expect(result.subtotal.toFixed(2)).toBe('16945.50');
    expect(result.customerPrice.toFixed(2)).toBe('10167.30');
  });

  it.each([
    ['family', 'FRENCH_DOOR'], ['brand', 'Eco Novo'], ['system', 'Serie 600'],
    ['crystal', '7/16 Lam [3/16 HS + .090 PVB + 3/16 HS]'],
    ['crystal', '1 1/16 Insulated [SGP]'],
    ['config', 'X'], ['config', 'O'], ['config', 'O/O'], ['config', 'OXO'],
  ])('keeps opening-dimension pricing outside the exact scope (%s = %s)', async (field, value) => {
    const f = fixture();
    if (field === 'family') f.product.diagramFamily = value;
    if (field === 'brand') f.catalog.system.brandProduct.brand.name = value;
    if (field === 'system') f.catalog.system.name = value;
    if (field === 'crystal') f.catalog.crystal.glass = value;
    if (field === 'config') f.config.conf = value;
    expect((await f.calculate({ height: '91' })).rate.toFixed(2)).toBe('4331.00'); // Opening H91, not Door H80; transom11 stays allowed.
  });

  it('does not reuse the selected crystal profile for another crystal in a cached estimate', async () => {
    const f = fixture();
    expect((await f.calculate()).rate.toFixed(2)).toBe('3825.00');
    f.tx.systemCrystal.findUnique.mockResolvedValue({ ...f.catalog, crystal: { glass: 'Insulated SGP' } });
    expect((await f.calculate({ idCryst: 2 })).rate.toFixed(2)).toBe('4745.00');
    expect(f.tx.systemCrystal.findUnique).toHaveBeenCalledTimes(2);
  });

  it('prices an O/X door component at door dimensions and leaves both O/O sidelites and glass surcharges at opening height', async () => {
    const f = fixture();
    f.config.conf = 'O/O-O/X-O/O';
    f.sysConf.pricingComponents = [
      { componentType: 'DOOR', sourceConfigId: 2, quantity: 1, sourceSysConf: { config: { conf: 'O/X' } } },
      { componentType: 'SIDELITE', sourceConfigId: 3, quantity: 2, sourceSysConf: { config: { conf: 'O/O' } } },
    ];
    f.tx.pricingRangeRule.findMany.mockImplementation(async ({ where }) => where.range.is.idConfig === 2
      ? [boundedRule()]
      : [boundedRule({ costoA: '144', costoB: '0', costoC: '0', range: {
        minWidthIn: null, maxWidthIn: null, minHeightIn: null, maxHeightIn: null,
      } })]);
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '1', costoB: '0', costoC: '0' });
    const result = await f.calculate({ width: '85', doorWidth: '45' });
    expect(result.rate.toFixed(2)).toBe('7884.03'); // 3825 + 20*100*2 + 31.25 + 13.89*2.
    expect(f.dimensions.validateAgainstDimensionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ width: '85', height: '100', doorWidth: '45', doorHeight: '80' }), f.tx,
    );
  });

  it('does not reinterpret a SIDELITE component as a door even if it points to O/X', async () => {
    const f = fixture();
    f.config.conf = 'O/O';
    f.sysConf.pricingComponents = [
      { componentType: 'SIDELITE', sourceConfigId: 2, quantity: 1, sourceSysConf: { config: { conf: 'O/X' } } },
    ];
    expect((await f.calculate({ width: '90', doorWidth: '45' })).rate.toFixed(2)).toBe('4745.00');
    expect(f.tx.systemCrystal.findUnique).not.toHaveBeenCalled();
  });
});

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

function transomAssemblyFixture(configuration = 'O/O-O/X', sideCount = 1) {
  const f = fixture();
  f.config.conf = configuration;
  f.sysConf.pricingComponents = [
    { componentType: 'DOOR', sourceConfigId: 2, quantity: 1, sourceSysConf: { config: { conf: 'O/X' } } },
    { componentType: 'SIDELITE', sourceConfigId: 3, quantity: sideCount, sourceSysConf: { config: { conf: 'O' } } },
  ];
  const doorRule = boundedRule();
  const sideliteRule = boundedRule();
  sideliteRule.range.minWidthIn = new Prisma.Decimal('10');
  f.tx.pricingRangeRule.findMany.mockImplementation(async ({ where }) =>
    where.range.is.idConfig === 2 ? [doorRule] : [sideliteRule]);
  const calculate = (overrides: Record<string, unknown> = {}) => f.calculate({
    width: '96', height: '120', doorWidth: '45', doorHeight: '96', ...overrides,
  });
  return { ...f, calculate, doorRule, sideliteRule };
}

describe('Pivot sidelite heights and reviewed Serie 1500 O/X SGP door pricing', () => {
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

  it('calculates the 96 by 120 opening with a 45 by 96 door and a 51 by 96 O using the reviewed V095 ranges', async () => {
    const f = transomAssemblyFixture();
    Object.assign(f.doorRule, { costoA: '109.41163150554675', costoB: '0.0', costoC: '3972.2761192828702' });
    Object.assign(f.doorRule.range, {
      minWidthIn: new Prisma.Decimal('38.875'), minWidthInclusive: false, maxWidthIn: new Prisma.Decimal('46'),
      minHeightIn: new Prisma.Decimal('94'), minHeightInclusive: false, maxHeightIn: new Prisma.Decimal('96'),
    });
    Object.assign(f.sideliteRule, { costoA: '64.18839117007887811507', costoB: '0', costoC: '1976.9728582866312' });
    Object.assign(f.sideliteRule.range, {
      minWidthIn: new Prisma.Decimal('46.5'), minWidthInclusive: false, maxWidthIn: new Prisma.Decimal('56'),
      minHeightIn: new Prisma.Decimal('92'), minHeightInclusive: false, maxHeightIn: new Prisma.Decimal('98'),
    });
    const result = await f.calculate();
    expect(result.rate.toFixed(2)).toBe('11414.01'); // Rounded components: 7254.63 + 4159.38.
    expect(f.tx.pricingRule.findUnique).not.toHaveBeenCalled();
    expect(f.dimensions.validateAgainstDimensionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ width: '96', height: '120', doorWidth: '45', doorHeight: '96' }), f.tx,
    );
  });

  it.each([
    ['O/O-O/X', 1, '9784.00'], ['O/X-O/O', 1, '9784.00'], ['O/O-O/X-O/O', 2, '9980.00'],
  ] as const)('prices every lower panel at Door Height but retains full-height glass surcharges in %s', async (configuration, sides, expected) => {
    const f = transomAssemblyFixture(configuration, sides);
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '1', costoB: '0', costoC: '0' });
    const result = await f.calculate();
    // Base: W*96 + W+96+100 per panel; glass surcharge: 96*120/144 = 80.
    expect(result.rate.toFixed(2)).toBe(expected);
    expect(result.height).toBe('120');
    expect(result.doorHeight).toBe('96');
    expect(f.tx.systemCrystal.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(['OX', 'XO', 'OXO'])('ignores a stale Door Height in the non-transom %s configuration', async configuration => {
    const f = transomAssemblyFixture(configuration, configuration === 'OXO' ? 2 : 1);
    f.sysConf.requiresDoorHeight = false;
    f.sysConf.pricingComponents[0].sourceSysConf.config.conf = 'X';
    const result = await f.calculate({ height: '100', doorHeight: '80' });
    expect(result.rate.toFixed(2)).toBe(configuration === 'OXO' ? '10296.00' : '10096.00');
    expect(f.tx.systemCrystal.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['brand', 'Eco Novo'], ['system', 'Serie 600'],
    ['crystal', '7/16 Lam [3/16 HS + .090 PVB + 3/16 HS]'], ['crystal', '1 1/16 Insulated [SGP]'],
  ])('uses Door Height for Pivot sidelites while keeping door pricing outside the reviewed scope (%s = %s)', async (field, value) => {
    const f = transomAssemblyFixture();
    if (field === 'brand') f.catalog.system.brandProduct.brand.name = value;
    if (field === 'system') f.catalog.system.name = value;
    if (field === 'crystal') f.catalog.crystal.glass = value;
    // Door: 45*100 + 45+100+100; sidelite: 51*80 + 51+80+100.
    expect((await f.calculate({ height: '100', doorHeight: '80' })).rate.toFixed(2)).toBe('9056.00');
  });

  it('retains opening-height component pricing for French Door assemblies', async () => {
    const f = transomAssemblyFixture();
    f.product.diagramFamily = 'FRENCH_DOOR';
    expect((await f.calculate({ height: '100', doorHeight: '80' })).rate.toFixed(2)).toBe('10096.00');
  });

  it('uses Door Height for both sidelites regardless of their source label and retains opening-height glass surcharges', async () => {
    const f = fixture();
    f.config.conf = 'O/O-O/X-O/O';
    f.sysConf.pricingComponents = [
      { componentType: 'DOOR', sourceConfigId: 2, quantity: 1, sourceSysConf: { config: { conf: 'O/X' } } },
      { componentType: 'SIDELITE', sourceConfigId: 3, quantity: 2, sourceSysConf: { config: { conf: 'Fixed lite' } } },
    ];
    f.tx.pricingRangeRule.findMany.mockImplementation(async ({ where }) => where.range.is.idConfig === 2
      ? [boundedRule()]
      : [boundedRule({ costoA: '144', costoB: '0', costoC: '0', range: {
        minWidthIn: null, maxWidthIn: null, minHeightIn: null, maxHeightIn: null,
      } })]);
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '1', costoB: '0', costoC: '0' });
    const result = await f.calculate({ width: '85', doorWidth: '45' });
    expect(result.rate.toFixed(2)).toBe('7084.03'); // 3825 + 20*80*2 + 31.25 + 13.89*2.
    expect(f.dimensions.validateAgainstDimensionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ width: '85', height: '100', doorWidth: '45', doorHeight: '80' }), f.tx,
    );
  });

  it('uses configured Door Height for a Pivot sidelite without an O/X door source or recognized configuration label', async () => {
    const f = transomAssemblyFixture('Custom entry layout');
    f.sysConf.pricingComponents[0].sourceSysConf.config.conf = 'X';
    f.sysConf.pricingComponents[1].sourceSysConf.config.conf = 'Fixed lite';
    expect((await f.calculate({ height: '100', doorHeight: '80' })).rate.toFixed(2)).toBe('9056.00');
    expect(f.tx.systemCrystal.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing required Door Height before querying component prices', async () => {
    const f = transomAssemblyFixture();
    await expect(f.calculate({ doorHeight: undefined })).rejects.toThrow('Missing required dimensions: doorHeight');
    expect(f.tx.pricingRangeRule.findMany).not.toHaveBeenCalled();
  });

  it('applies a sidelite commercial minimum after selecting its actual Door Height', async () => {
    const f = transomAssemblyFixture();
    f.sysConf.pricingComponents[1].sourceSysConf.minimumBillableHeightIn = '100';
    // Door: 45*96 + 45+96+100; sidelite: 51*100 + 51+100+100.
    expect((await f.calculate()).rate.toFixed(2)).toBe('9912.00');
  });
});

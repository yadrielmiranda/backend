import Decimal from 'decimal.js';
import { EstimatePieceCalculatorService } from './estimate-piece-calculator.service';
import { applyDesignBaseModifier, applyFrameBaseModifier } from '@/pricing/frame-base-modifier';
import { withStoredPieceDesign } from '@/pieces/piece-design';

function fixture(linear = false) {
  const calculator = new EstimatePieceCalculatorService({
    computeGoverningDimsFromConfig: jest.fn(async piece => ({ widthIn: piece.width, heightIn: piece.height })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  } as any, { normalizePieceMuntinFromCatalog: jest.fn(async () => null) } as any);
  const cache = calculator.createCalculationCache();
  cache.product.set(1, { id: 1, isActive: true, allowMuntin: false,
    kind: linear ? 'LINEAR_MATERIAL' : 'GLAZED_UNIT', pricingMode: linear ? 'LINEAR_INCH' : 'AREA_PERIMETER' });
  cache.config.set(1, { conf: 'Custom', requiresWidth: true, requiresHeight: !linear, fixedPanelCount: null } as any);
  for (const idSystem of [1, 2]) {
    cache.sysConf.set(`${idSystem}-1`, { isSelectableInEstimate: true, dimensionMode: 'STANDARD',
      activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [] });
    cache.highBottomSettings.set(`1-${idSystem}`, { idBrand: 1, allowHighBottom: true,
      brandProduct: { brand: { highBottomPercent: '10' } } });
    cache.linearPricing.set(`1-1-${idSystem}-1`, { minLengthIn: '1', maxLengthIn: '200', costPerInch: '2' });
  }
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  const frames = new Map<string, any>([
    ['1-1', { idSystem: 1, idFrameColor: 1, modifierEnabled: false, basePriceMultiplier: '1', basePriceDeduction: '0' }],
    ['1-7', { idSystem: 1, idFrameColor: 7, modifierEnabled: true, basePriceMultiplier: '2', basePriceDeduction: '10' }],
    ['2-7', { idSystem: 2, idFrameColor: 7, modifierEnabled: true, basePriceMultiplier: '3', basePriceDeduction: '20' }],
  ]);
  const designModifiers = new Map<string, any>();
  const designTemplates = new Map<number, unknown>();
  const tx: any = {
    systemFrameColor: { findUnique: jest.fn(async ({ where }) => {
      const { idSystem, idFrameColor } = where.idSystem_idFrameColor;
      const record = frames.get(`${idSystem}-${idFrameColor}`);
      return record ? { ...record, frameColor: { isActive: true } } : null;
    }) },
    systemDesignColorModifier: { findUnique: jest.fn(async ({ where }) => {
      const { idSystem, idDesignColor } = where.idSystem_idDesignColor;
      return designModifiers.get(`${idSystem}-${idDesignColor}`) ?? null;
    }) },
    systemDesignOption: { findUnique: jest.fn(async ({ where }) => {
      const { idDesign, idDesignColor } = where.idSystem_idDesign_idDesignColor;
      return {
        system: { idBrand: 1, idProduct: 1, isActive: true, allowDesign: true, brandProduct: { product: { diagramFamily: 'GARAGE_DOOR' } } },
        design: { id: idDesign, name: `Pattern ${idDesign}`, imageUrl: null, isActive: true, template: designTemplates.get(idDesign) },
        color: { id: idDesignColor, name: `Finish ${idDesignColor}`, hexCode: '#123456', isActive: true, idFrameColor: 7 },
      };
    }) },
    pricingRangeRule: { findMany: jest.fn(async () => []) },
    pricingRule: { findUnique: jest.fn(async () => ({ costoA: '0', costoB: '0', costoC: '1000' })) },
    tint: { findUnique: jest.fn(async ({ where }) => [1, 8].includes(where.id) ? { id: where.id } : null) },
    coating: { findUnique: jest.fn(async ({ where }) => [1, 8].includes(where.id) ? { id: where.id } : null) },
    privacy: { findUnique: jest.fn(async ({ where }) => [1, 8].includes(where.id) ? { id: where.id } : null) },
  };
  const calculate = (overrides: Record<string, unknown> = {}, markup = '0', stored?: any) => calculator.calculatePieceMetrics(withStoredPieceDesign({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    ...(linear ? {} : { idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1 }),
    width: '48', height: '60', qty: 1, dealerMarkup: 0, mark: 'A', ...overrides,
  } as any, stored), new Decimal(markup), tx, cache);
  return { calculate, cache, tx, frames, designModifiers, designTemplates };
}

describe('Solid garage design pricing', () => {
  const solid = { version: 1, columns: [1], rows: [.5, .5], cells: [['slat'], ['slat']] };
  const glazed = { ...solid, cells: [['glass'], ['slat']] };
  const selected = { idDesign: 11, idDesignColor: 12 };
  function solidFixture() {
    const f = fixture();
    f.designTemplates.set(11, solid);
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1.5', basePriceDeduction: '20' });
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '2', costoB: '.5', costoC: '3' });
    Object.assign(f.cache.brandCoating.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '4' });
    Object.assign(f.cache.brandPrivacy.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '5' });
    return f;
  }

  it('omits all glass-option charges while retaining the crystal base rule, design modifier, other options and margins', async () => {
    const f = solidFixture();
    const result = await f.calculate({ ...selected, idCryst: 6, highBottom: true, qty: 3, dealerMarkup: 20 }, '.1');
    expect(result.idCryst).toBe(6);
    expect(result.idTint).toBe(1);
    expect(result.idCoat).toBe(1);
    expect(result.idPrivacy).toBe(1);
    expect(result.rate.toFixed(2)).toBe('1628.00'); // (1000 * 1.5 - 20) * 1.10, with no glass surcharges.
    expect(result.price.toFixed(2)).toBe('1790.80');
    expect(result.subtotal.toFixed(2)).toBe('5372.40');
    expect(result.customerSubtotal.toFixed(2)).toBe('6446.88');
    expect(f.tx.pricingRule.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: {
      idBrand_idProduct_idSystem_idConfig_idCrystal: expect.objectContaining({ idCrystal: 6 }),
    } }));
  });

  it.each([null, undefined, 0, -1])('allows absent/nonpositive hidden glass options and normalizes them to null (%j)', async value => {
    const f = solidFixture();
    const result = await f.calculate({ ...selected, idTint: value, idCoat: value, idPrivacy: value });
    expect(result.rate.toString()).toBe('1480');
    expect([result.idTint, result.idCoat, result.idPrivacy]).toEqual([null, null, null]);
    expect(f.tx.tint.findUnique).not.toHaveBeenCalled();
    expect(f.tx.coating.findUnique).not.toHaveBeenCalled();
    expect(f.tx.privacy.findUnique).not.toHaveBeenCalled();
  });

  it('keeps existing catalog IDs without requiring active brand associations or complete surcharge rates', async () => {
    const f = solidFixture();
    for (const [cache, field] of [[f.cache.brandTint, 'tint'], [f.cache.brandCoating, 'coating'], [f.cache.brandPrivacy, 'privacy']] as const)
      cache.set('1-1', { [field]: { isActive: false }, surchargeEnabled: true, costoA: null });
    const inactive = await f.calculate(selected);
    expect([inactive.idTint, inactive.idCoat, inactive.idPrivacy]).toEqual([1, 1, 1]);
    const unassociated = await f.calculate({ ...selected, idTint: 8, idCoat: 8, idPrivacy: 8 });
    expect([unassociated.idTint, unassociated.idCoat, unassociated.idPrivacy]).toEqual([8, 8, 8]);
    expect(unassociated.rate.toString()).toBe('1480');
    expect(f.tx.tint.findUnique).toHaveBeenCalledWith({ where: { id: 8 }, select: { id: true } });
  });

  it('clears stale nonexistent IDs before persistence instead of leaving invalid foreign keys', async () => {
    const f = solidFixture();
    const result = await f.calculate({ ...selected, idTint: 999, idCoat: 999, idPrivacy: 999 });
    expect([result.idTint, result.idCoat, result.idPrivacy]).toEqual([null, null, null]);
    expect(result.idCryst).toBe(1);
    expect(result.rate.toString()).toBe('1480');
  });

  it('still requires the crystal used to calculate the base', async () => {
    const f = solidFixture();
    await expect(f.calculate({ ...selected, idCryst: null })).rejects.toThrow('Glass is required');
  });

  it('restores validation and charges for a glass design or when the design is removed', async () => {
    const f = solidFixture();
    const saved = await f.calculate(selected);
    f.designTemplates.set(22, glazed);
    const glass = await f.calculate({ ...selected, idDesign: 22 }, '0', saved);
    expect(glass.rate.toString()).toBe('1541'); // 1480 + 52 + 4 + 5.
    await expect(f.calculate({ ...selected, idDesign: 22, idTint: null }, '0', saved)).rejects.toThrow('Tint is required');
    expect((await f.calculate({ idDesign: null, idDesignColor: null }, '0', saved)).rate.toString()).toBe('1061');
  });

  it('uses the saved template for recalculation even if the catalog design later gains glass', async () => {
    const f = solidFixture();
    const saved = await f.calculate(selected);
    f.designTemplates.set(11, glazed);
    const recalculated = await f.calculate({}, '0', saved);
    expect(recalculated.rate.toString()).toBe('1480');
    expect(f.tx.systemDesignOption.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, { ...solid, cells: [] }])('keeps normal glass pricing for absent or invalid templates (%j)', async template => {
    const f = solidFixture();
    f.designTemplates.set(11, template);
    expect((await f.calculate(selected)).rate.toString()).toBe('1541');
    await expect(f.calculate({ ...selected, idTint: null })).rejects.toThrow('Tint is required');
  });

  it('does not accept a caller-supplied snapshot to bypass glass charges', async () => {
    const f = solidFixture();
    f.designTemplates.set(11, glazed);
    const forged = { version: 1, systemId: 1, design: { id: 11, name: 'Any', template: solid },
      color: { id: 12, name: 'Finish', hexCode: '#123456', idFrameColor: 7 } };
    expect((await f.calculate({ ...selected, designSnapshot: forged })).rate.toString()).toBe('1541');
  });
});

describe('Configured frame base modifier in the shared calculator', () => {
  it('keeps inactive modifiers neutral even when saved values differ from 1 and 0', async () => {
    const f = fixture();
    f.frames.get('1-1').basePriceMultiplier = '4';
    f.frames.get('1-1').basePriceDeduction = '500';
    expect((await f.calculate()).rate.toString()).toBe('1000');
  });

  it('changes only the base before high bottom, glass options, margins and quantity', async () => {
    const f = fixture();
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '2', costoB: '.5', costoC: '3' });
    Object.assign(f.cache.brandCoating.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '4' });
    Object.assign(f.cache.brandPrivacy.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '5' });
    const result = await f.calculate({ idFC: 7, highBottom: true, qty: 3, dealerMarkup: 20 }, '.1');
    // (1000 * 2 - 10) * 1.10 + (20 * 2 + 18 * .5 + 3) + 4 + 5.
    expect(result.rate.toFixed(2)).toBe('2250.00');
    expect(result.price.toFixed(2)).toBe('2475.00');
    expect(result.subtotal.toFixed(2)).toBe('7425.00');
    expect(result.customerPrice.toFixed(2)).toBe('2970.00');
    expect(result.customerSubtotal.toFixed(2)).toBe('8910.00');
    expect(f.tx.systemFrameColor.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: {
      idSystem: true, idFrameColor: true, modifierEnabled: true, basePriceMultiplier: true, basePriceDeduction: true,
    } }));
  });

  it('keeps series/color values separate in the calculation cache', async () => {
    const f = fixture();
    expect((await f.calculate({ idFC: 7 })).rate.toString()).toBe('1990');
    expect((await f.calculate({ idSyst: 2, idFC: 7 })).rate.toString()).toBe('2980');
    expect((await f.calculate({ idFC: 1 })).rate.toString()).toBe('1000');
    expect((await f.calculate({ idFC: 7 })).rate.toString()).toBe('1990');
    expect(f.tx.systemFrameColor.findUnique).toHaveBeenCalledTimes(3);
  });

  it('applies the modifier once to the combined component base', async () => {
    const f = fixture();
    Object.assign(f.cache.sysConf.get('1-1'), { dimensionMode: 'ECO_WINDOWS_DOOR', pricingComponents: [
      { componentType: 'DOOR', sourceConfigId: 2, quantity: 1, sourceSysConf: { config: { conf: 'Door' } } },
      { componentType: 'SIDELITE', sourceConfigId: 3, quantity: 2, sourceSysConf: { config: { conf: 'Sidelite' } } },
    ] });
    Object.assign(f.frames.get('1-7'), { basePriceMultiplier: '1.5', basePriceDeduction: '20' });
    f.tx.pricingRule.findUnique.mockImplementation(async ({ where }) => ({
      costoA: '0', costoB: '0', costoC: where.idBrand_idProduct_idSystem_idConfig_idCrystal.idConfig === 2 ? '300' : '100',
    }));
    const result = await f.calculate({ idFC: 7, width: '96', height: '72', doorWidth: '48', qty: 3 });
    expect(result.rate.toString()).toBe('730'); // (300 + 100 + 100) * 1.5 - 20.
    expect(result.subtotal.toString()).toBe('2190');
  });

  it('subtracts once after aggregating Window Wall panels', async () => {
    const f = fixture();
    Object.assign(f.cache.sysConf.get('1-1'), { dimensionMode: 'WINDOW_WALL', requiresPanelCount: true });
    const result = await f.calculate({ idFC: 7, width: '144', panelCount: 3 });
    expect(result.rate.toString()).toBe('5990');
  });

  it('supports linear pieces with the same configured modifier', async () => {
    const f = fixture(true);
    expect((await f.calculate()).rate.toString()).toBe('96');
    const modified = await f.calculate({ idFC: 7, qty: 2 }, '.1');
    expect(modified.rate.toString()).toBe('182');
    expect(modified.subtotal.toFixed(2)).toBe('400.40');
  });

  it('keeps the design-linked frame while omitting its modifier when a design is selected', async () => {
    const f = fixture();
    const result = await f.calculate({ idFC: 1, idDesign: 11, idDesignColor: 12 });
    expect(result.idFC).toBe(7);
    expect(result.rate.toString()).toBe('1000');
    expect(result.designSnapshot?.color.idFrameColor).toBe(7);
  });

  it('rejects a negative adjusted base instead of clamping it or pricing with extra charges', async () => {
    const f = fixture();
    f.frames.get('1-7').basePriceDeduction = '2001';
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '50' });
    await expect(f.calculate({ idFC: 7 })).rejects.toThrow('negative base price');
  });
});

describe('Design color modifier precedence in the shared calculator', () => {
  it('replaces the frame modifier on the original base before other options, markup and quantity', async () => {
    const f = fixture();
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1.5', basePriceDeduction: '20' });
    Object.assign(f.cache.brandTint.get('1-1'), { surchargeEnabled: true, costoA: '2', costoB: '.5', costoC: '3' });
    Object.assign(f.cache.brandCoating.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '4' });
    Object.assign(f.cache.brandPrivacy.get('1-1'), { surchargeEnabled: true, costoA: '0', costoB: '0', costoC: '5' });
    const result = await f.calculate({ idDesign: 11, idDesignColor: 12, highBottom: true, qty: 3, dealerMarkup: 20 }, '.1');
    // (1000 * 1.5 - 20) * 1.10 + (20 * 2 + 18 * .5 + 3) + 4 + 5.
    expect(result.rate.toFixed(2)).toBe('1689.00');
    expect(result.price.toFixed(2)).toBe('1857.90');
    expect(result.subtotal.toFixed(2)).toBe('5573.70');
    expect(result.customerPrice.toFixed(2)).toBe('2229.48');
    expect(result.customerSubtotal.toFixed(2)).toBe('6688.44');
    expect(result.idFC).toBe(7);
    expect(f.tx.systemDesignColorModifier.findUnique).toHaveBeenCalledWith({
      where: { idSystem_idDesignColor: { idSystem: 1, idDesignColor: 12 } },
      select: { modifierEnabled: true, basePriceMultiplier: true, basePriceDeduction: true },
    });
  });

  it.each([null, { modifierEnabled: false, basePriceMultiplier: '9', basePriceDeduction: '300' }])(
    'uses the original base for missing or disabled design settings, never the frame modifier (%j)', async modifier => {
      const f = fixture();
      if (modifier) f.designModifiers.set('1-12', modifier);
      const selected = { idDesign: 11, idDesignColor: 12 };
      expect((await f.calculate(selected)).rate.toString()).toBe('1000');
      expect((await f.calculate(selected)).rate.toString()).toBe('1000');
      expect(f.tx.systemDesignColorModifier.findUnique).toHaveBeenCalledTimes(1);
      expect((await f.calculate({ idFC: 7, idDesign: null, idDesignColor: null })).rate.toString()).toBe('1990');
    },
  );

  it('shares one modifier across patterns, while separating series and design colors in the cache', async () => {
    const f = fixture();
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1.5', basePriceDeduction: '20' });
    f.designModifiers.set('2-12', { modifierEnabled: true, basePriceMultiplier: '1.8', basePriceDeduction: '30' });
    f.designModifiers.set('1-13', { modifierEnabled: true, basePriceMultiplier: '1.25', basePriceDeduction: '7.125' });
    expect((await f.calculate({ idDesign: 11, idDesignColor: 12 })).rate.toString()).toBe('1480');
    expect((await f.calculate({ idDesign: 22, idDesignColor: 12 })).rate.toString()).toBe('1480');
    expect((await f.calculate({ idSyst: 2, idDesign: 11, idDesignColor: 12 })).rate.toString()).toBe('1770');
    expect((await f.calculate({ idDesign: 11, idDesignColor: 13 })).rate.toString()).toBe('1242.88');
    expect(f.tx.systemDesignColorModifier.findUnique).toHaveBeenCalledTimes(3);
  });

  it('recalculates an existing saved design using its current color modifier when older callers omit design fields', async () => {
    const f = fixture();
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1.5', basePriceDeduction: '20' });
    const saved = await f.calculate({ idDesign: 11, idDesignColor: 12 });
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1.6', basePriceDeduction: '25' });
    f.cache.systemDesignColorModifier.clear();
    const recalculated = await f.calculate({}, '0', saved);
    expect(recalculated.idDesignColor).toBe(12);
    expect(recalculated.idDesign).toBe(11);
    expect(recalculated.idFC).toBe(7);
    expect(recalculated.rate.toString()).toBe('1575');
    // The saved snapshot retains the design even if it is no longer offered.
    expect(f.tx.systemDesignOption.findUnique).toHaveBeenCalledTimes(1);
  });

  it('reports a design modifier error in Manage Designs rather than using a frame fallback', async () => {
    const f = fixture();
    f.designModifiers.set('1-12', { modifierEnabled: true, basePriceMultiplier: '1', basePriceDeduction: '1001' });
    await expect(f.calculate({ idDesign: 11, idDesignColor: 12 })).rejects.toThrow('Manage Designs');
  });

  it('preserves the full decimal precision of design values', () => {
    expect(applyDesignBaseModifier(new Decimal(2), { modifierEnabled: true,
      basePriceMultiplier: '1.00000000000000000001', basePriceDeduction: '0.00000000000000000001',
    }).toString()).toBe('2.00000000000000000001');
  });
});

describe('Frame base modifier decimal arithmetic', () => {
  it('preserves all stored decimal places without rounding intermediate results', () => {
    expect(applyFrameBaseModifier(new Decimal(2), { modifierEnabled: true,
      basePriceMultiplier: '1.00000000000000000001', basePriceDeduction: '0.00000000000000000001',
    }).toString()).toBe('2.00000000000000000001');
  });

  it.each([
    { basePriceMultiplier: '0', basePriceDeduction: '0' },
    { basePriceMultiplier: '-1', basePriceDeduction: '0' },
    { basePriceMultiplier: '1', basePriceDeduction: '-1' },
    { basePriceMultiplier: 'NaN', basePriceDeduction: '0' },
    { basePriceMultiplier: 'Infinity', basePriceDeduction: '0' },
    { basePriceMultiplier: '1', basePriceDeduction: 'bad' },
    { basePriceMultiplier: '1', basePriceDeduction: null },
  ])('rejects invalid active modifier values %j', values => {
    expect(() => applyFrameBaseModifier(new Decimal(100), { modifierEnabled: true, ...values })).toThrow('Manage Frame Colors');
  });

  it('allows an adjusted base of exactly zero', () => {
    expect(applyFrameBaseModifier(new Decimal(100), { modifierEnabled: true,
      basePriceMultiplier: '2', basePriceDeduction: '200',
    }).toString()).toBe('0');
  });
});

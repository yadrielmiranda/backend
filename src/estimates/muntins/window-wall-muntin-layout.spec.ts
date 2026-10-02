import Decimal from 'decimal.js';
import { EstimatePieceCalculatorService } from '../calculation/estimate-piece-calculator.service';
import { EstimateMuntinService } from './estimate-muntin.service';
import { buildWindowWallMuntinLayout, normalizeWindowWallMuntinPanels } from './window-wall-muntin-layout';

const cell = (row: number, column: number, index: number, horizontalLites = 2, verticalLites = 3) => ({
  panelIndex: index, panelCode: `R${row}C${column}`, panelLabel: 'Incoming label', horizontalLites, verticalLites,
});
const uniform = (horizontalLites = 1, verticalLites = 1) => ({
  panelIndex: 1, panelCode: 'O', panelLabel: 'All glass panels', horizontalLites, verticalLites,
});

function fixture(mode = 'ALL', allowedIds = [7]) {
  const normalizer = new EstimateMuntinService();
  const normalization = jest.spyOn(normalizer, 'normalizePieceMuntinFromCatalog');
  const dimensions = {
    computeGoverningDimsFromConfig: jest.fn(async dto => ({ widthIn: Number(dto.width), heightIn: Number(dto.height) })),
    validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
  };
  const calculator = new EstimatePieceCalculatorService(dimensions as any, normalizer);
  const cache = calculator.createCalculationCache();
  cache.product.set(1, { id: 1, isActive: true, kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER' });
  // Window Wall uses a shared specification without requiring a static layout.
  cache.config.set(1, { conf: 'Window Wall', fixedPanelCount: null, muntinLayout: null } as any);
  cache.sysConf.set('1-1', {
    isSelectableInEstimate: true, dimensionMode: 'WINDOW_WALL',
    requiresWidth: true, requiresHeight: true, requiresPanelCount: true, requiresHorizontalHeights: true,
    muntinAvailability: mode, allowedMuntinTypes: allowedIds.map(muntinTypeId => ({ muntinTypeId })),
    activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [],
  });
  cache.systemFrameColor.set('1-1', {});
  cache.highBottomSettings.set('1-1', { idBrand: 1, allowHighBottom: false });
  cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
  cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
  cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
  const db = {
    muntinPattern: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, requiresLites: where.id !== 1 })) },
    muntinType: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, isActive: true })) },
    pricingRangeRule: { findMany: jest.fn(async () => []) },
    pricingRule: { findUnique: jest.fn(async () => ({ costoA: '0', costoB: '0', costoC: '100' })) },
  };
  const calculate = (overrides: Record<string, unknown> = {}) => calculator.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1, idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '108', height: '96', panelCount: 3, horizontalHeights: [48], qty: 1, mark: 'WW',
    muntin: { idPattern: 2, idType: 7, panels: [] }, ...overrides,
  } as any, new Decimal('.2'), db as any, cache);
  return { calculate, normalization, db, cache, normalizer };
}

describe('Window Wall shared muntin specification', () => {
  it('defines one shared panel regardless of the number or order of physical divisions', () => {
    const expected = [{ panelIndex: 1, panelCode: 'O', panelLabel: 'All glass panels' }];
    expect(buildWindowWallMuntinLayout(3, [48], 96)).toEqual(expected);
    expect(buildWindowWallMuntinLayout(2, [72, 24], 96)).toEqual(expected);
    expect(buildWindowWallMuntinLayout(1, [], 96)).toEqual(expected);
  });

  it.each([
    { count: 0, positions: [] }, { count: 1.5, positions: [] },
    { count: 3, positions: [48, 48] }, { count: 3, positions: [0] },
    { count: 3, positions: [96] }, { count: 3, positions: [Infinity] },
  ])('rejects invalid geometry $count/$positions', ({ count, positions }) => {
    expect(() => buildWindowWallMuntinLayout(count, positions, 96)).toThrow();
  });

  it('defaults an empty selection to one 1x1 grid', () => {
    expect(normalizeWindowWallMuntinPanels()).toEqual([uniform()]);
    expect(normalizeWindowWallMuntinPanels([])).toEqual([uniform()]);
  });

  it('preserves a single selection and replaces obsolete per-cell metadata', () => {
    const incoming = [cell(4, 5, 20, 3, 4)];
    expect(normalizeWindowWallMuntinPanels(incoming)).toEqual([uniform(3, 4)]);
    expect(incoming).toEqual([cell(4, 5, 20, 3, 4)]);
  });

  it('collapses uniform legacy grids without requiring a complete coordinate layout', () => {
    const incoming = [cell(2, 3, 6), cell(1, 2, 2), { ...cell(1, 1, 1), panelCode: 'O' }];
    const before = JSON.stringify(incoming);
    expect(normalizeWindowWallMuntinPanels(incoming)).toEqual([uniform(2, 3)]);
    expect(normalizeWindowWallMuntinPanels([...incoming].reverse())).toEqual([uniform(2, 3)]);
    expect(JSON.stringify(incoming)).toBe(before);
  });

  it.each([
    { horizontal: 3, vertical: 3 }, { horizontal: 2, vertical: 4 }, { horizontal: 3, vertical: 2 },
  ])('rejects mixed legacy grids instead of choosing one ($horizontal/$vertical)', ({ horizontal, vertical }) => {
    expect(() => normalizeWindowWallMuntinPanels([cell(1, 1, 1), cell(1, 2, 2, horizontal, vertical)]))
      .toThrow('Reconfigure the saved grids');
  });

  it.each([0, -1, 1.5, Infinity, NaN, undefined].map(value => ({ value })))('rejects invalid horizontal or vertical lite counts: $value', ({ value }) => {
    expect(() => normalizeWindowWallMuntinPanels([{ ...uniform(), horizontalLites: value }]))
      .toThrow('positive whole numbers');
    expect(() => normalizeWindowWallMuntinPanels([uniform(), { ...uniform(), verticalLites: value }]))
      .toThrow('positive whole numbers');
  });
});

describe('Window Wall through the real shared calculator and normalizer', () => {
  it('ignores the global static layout and persists only one shared grid for six glass cells', async () => {
    const f = fixture();
    f.cache.config.get(1)!.muntinLayout = [{ panelIndex: 1, panelCode: 'O', panelLabel: 'Old whole panel' }];
    const input = [cell(2, 3, 6), cell(1, 2, 2), cell(2, 1, 4), cell(1, 1, 1), cell(2, 2, 5), cell(1, 3, 3)];
    const result = await f.calculate({ muntin: { idPattern: 2, idType: 7, panels: input } });
    expect(result.muntin!.panels).toEqual([uniform(2, 3)]);
    const persisted = f.normalizer.buildPieceMuntinCreateInput(result.muntin as any)!;
    expect(persisted.panels!.create).toEqual([uniform(2, 3)]);
    expect(persisted.totalLites).toBe(6);
  });

  it('defaults to a shared 1x1 grid and retains fixed physical panel count resolution', async () => {
    const f = fixture();
    f.cache.config.get(1)!.fixedPanelCount = 2;
    const result = await f.calculate({ panelCount: 8 });
    expect(result.panelCount).toBe(2);
    expect(result.muntin!.panels).toEqual([uniform()]);
  });

  it('preserves the single H/V pair after changing columns and horizontal divisions', async () => {
    const f = fixture();
    const original = await f.calculate({ muntin: { idPattern: 2, idType: 7, panels: [uniform(4, 2)] } });
    const resized = await f.calculate({ panelCount: 4, horizontalHeights: [24, 48, 72], muntin: original.muntin });
    expect(resized.panelCount).toBe(4);
    expect(resized.muntin).toEqual(original.muntin);
  });

  it('rejects heterogeneous saved grids before returning a calculated piece', async () => {
    const f = fixture();
    await expect(f.calculate({ muntin: { idPattern: 2, idType: 7, panels: [cell(1, 1, 1), cell(1, 2, 2, 4, 2)] } }))
      .rejects.toThrow('Reconfigure the saved grids');
  });

  it('keeps the existing pricing formula independent of the shared grid and totalLites', async () => {
    const f = fixture();
    const noMuntin = await f.calculate({ qty: 2, muntin: null });
    const withMuntin = await f.calculate({ qty: 2, muntin: { idPattern: 2, idType: 7, panels: [uniform(4, 5)] } });
    for (const key of ['rate', 'price', 'subtotal', 'customerPrice', 'customerSubtotal'] as const)
      expect(withMuntin[key].toString()).toBe(noMuntin[key].toString());
    expect(f.normalizer.buildPieceMuntinCreateInput(withMuntin.muntin as any)!.totalLites).toBe(20);
  });

  it('keeps NONE and SELECTED type restrictions on the shared grid', async () => {
    await expect(fixture('NONE').calculate()).rejects.toThrow('not available');
    await expect(fixture('SELECTED', [8]).calculate()).rejects.toThrow('not allowed');
    await expect(fixture('SELECTED', [7]).calculate()).resolves.toMatchObject({ muntin: { idType: 7 } });
  });

  it('permits Full View with stale panel metadata and omits all grids', async () => {
    const f = fixture('NONE');
    const result = await f.calculate({ muntin: { idPattern: 1, idType: 999, panels: [cell(9, 9, 1)] } });
    expect(result.muntin).toEqual({ idPattern: 1, idType: null, panels: [] });
    expect(f.db.muntinType.findUnique).not.toHaveBeenCalled();
  });

  it.each([[48, 48], [10], [96]].map(positions => ({ positions })))('retains existing horizontal dimension validation for $positions', async ({ positions }) => {
    const f = fixture();
    await expect(f.calculate({ horizontalHeights: positions })).rejects.toThrow();
    expect(f.normalization).not.toHaveBeenCalled();
  });
});

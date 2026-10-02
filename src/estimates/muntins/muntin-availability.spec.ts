import Decimal from 'decimal.js';
import { EstimateMuntinService } from './estimate-muntin.service';
import { EstimatePieceCalculatorService } from '../calculation/estimate-piece-calculator.service';
import type { MuntinAvailabilityPolicy } from '@/systems/muntin-availability';

const layout = [{ panelIndex: 1, panelLabel: 'Glass' }];
const divided = { idPattern: 2, idType: 7, panels: [] };
const policy = (mode: MuntinAvailabilityPolicy['muntinAvailability'], ids = [7]): MuntinAvailabilityPolicy => ({
  muntinAvailability: mode, allowedMuntinTypeIds: ids,
});

function catalog() {
  return {
    muntinPattern: { findUnique: jest.fn(async ({ where }) =>
      where.id === 1 ? { id: 1, requiresLites: false } : { id: 2, requiresLites: true }) },
    muntinType: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, isActive: true })) },
  };
}

describe('muntin availability enforced by the server', () => {
  const service = new EstimateMuntinService();

  it.each(['NONE', 'ALL', 'SELECTED'] as const)('allows Full View under %s without a layout or a valid old type', async mode => {
    const db = catalog();
    const result = await service.normalizePieceMuntinFromCatalog(
      { idPattern: 1, idType: 999, panels: [{ panelIndex: 1, panelLabel: 'Old', horizontalLites: 4, verticalLites: 3 }] },
      null, db as any, policy(mode, []),
    );
    expect(result).toEqual({ idPattern: 1, idType: null, panels: [] });
    expect(db.muntinType.findUnique).not.toHaveBeenCalled();
  });

  it('allows an omitted muntin without touching the catalog', async () => {
    const db = catalog();
    await expect(service.normalizePieceMuntinFromCatalog(null, layout, db as any, policy('NONE'))).resolves.toBeNull();
    expect(db.muntinPattern.findUnique).not.toHaveBeenCalled();
  });

  it('rejects divisions in NONE even when the shared configuration has a layout', async () => {
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, catalog() as any, policy('NONE')))
      .rejects.toThrow('not available for this series and configuration');
  });

  it('allows any active type in ALL, independent of the selected list', async () => {
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, catalog() as any, policy('ALL', [])))
      .resolves.toMatchObject({ idType: 7, panels: [{ panelIndex: 1, horizontalLites: 1, verticalLites: 1 }] });
  });

  it('accepts selected types and rejects a forged type outside the selected list', async () => {
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, catalog() as any, policy('SELECTED')))
      .resolves.toMatchObject({ idType: 7 });
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, catalog() as any, policy('SELECTED', [8])))
      .rejects.toThrow('not allowed for this series and configuration');
  });

  it.each(['ALL', 'SELECTED'] as const)('rejects inactive, missing and omitted types in %s', async mode => {
    const db = catalog();
    db.muntinType.findUnique.mockResolvedValue({ id: 7, isActive: false });
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, db as any, policy(mode)))
      .rejects.toThrow('invalid or inactive');
    db.muntinType.findUnique.mockResolvedValue(null as any);
    await expect(service.normalizePieceMuntinFromCatalog(divided, layout, db as any, policy(mode)))
      .rejects.toThrow('invalid or inactive');
    await expect(service.normalizePieceMuntinFromCatalog({ ...divided, idType: null }, layout, db as any, policy(mode)))
      .rejects.toThrow('Select a muntin type');
  });

  it('still requires configuration geometry when a type is permitted', async () => {
    await expect(service.normalizePieceMuntinFromCatalog(divided, null, catalog() as any, policy('ALL')))
      .rejects.toThrow('does not define a muntin layout');
  });
});

describe('shared estimate calculator uses the selected series/configuration policy', () => {
  it('keeps two series with the same global layout independent', async () => {
    const service = new EstimatePieceCalculatorService({
      computeGoverningDimsFromConfig: jest.fn(async () => ({ widthIn: 36, heightIn: 48 })),
      validateAgainstDimensionPolicy: jest.fn(async () => ({ ok: true, dpPos: 70, dpNeg: -70 })),
    } as any, new EstimateMuntinService());
    const cache = service.createCalculationCache();
    cache.product.set(1, { id: 1, isActive: true, kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER' });
    cache.config.set(1, { conf: 'Fixed', requiresWidth: true, requiresHeight: true, muntinLayout: layout } as any);
    for (const systemId of [1, 2]) {
      cache.systemFrameColor.set(`${systemId}-1`, {});
      cache.highBottomSettings.set(`1-${systemId}`, { idBrand: 1, allowHighBottom: false });
    }
    cache.brandTint.set('1-1', { tint: { isActive: true }, surchargeEnabled: false });
    cache.brandCoating.set('1-1', { coating: { isActive: true }, surchargeEnabled: false });
    cache.brandPrivacy.set('1-1', { privacy: { isActive: true }, surchargeEnabled: false });
    const db = {
      ...catalog(),
      sysConf: { findUnique: jest.fn(async ({ where }) => ({
        isSelectableInEstimate: true, dimensionMode: 'STANDARD',
        muntinAvailability: where.idSystem_idConfig.idSystem === 1 ? 'NONE' : 'SELECTED',
        allowedMuntinTypes: [{ muntinTypeId: 7 }],
        activeOptions: [], preparationOptions: [], sillOptions: [], reinforcementOptions: [],
      })) },
      pricingRangeRule: { findMany: jest.fn(async () => []) },
      pricingRule: { findUnique: jest.fn(async () => ({ costoA: '0', costoB: '0', costoC: '100' })) },
    };
    const input = {
      idProd: 1, idBrand: 1, idConf: 1, idFC: 1, idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
      height: '48', width: '36', qty: 1, mark: 'A', muntin: divided,
    };
    await expect(service.calculatePieceMetrics({ ...input, idSyst: 1 } as any, new Decimal('.2'), db as any, cache))
      .rejects.toThrow('not available for this series and configuration');
    await expect(service.calculatePieceMetrics({ ...input, idSyst: 2 } as any, new Decimal('.2'), db as any, cache))
      .resolves.toMatchObject({ muntin: { idType: 7 } });
    expect(db.sysConf.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { idSystem_idConfig: { idSystem: 2, idConfig: 1 } },
      select: expect.objectContaining({ muntinAvailability: true, allowedMuntinTypes: { select: { muntinTypeId: true } } }),
    }));
  });
});

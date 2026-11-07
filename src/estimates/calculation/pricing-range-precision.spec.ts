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
  const calculate = (value: string, design = {}) => service.calculatePieceMetrics({
    idProd: 1, idBrand: 1, idSyst: 1, idConf: 1, idFC: 1,
    idCryst: 1, idTint: 1, idCoat: 1, idPrivacy: 1,
    width: '48', height: '48', [axis]: value, qty: 1, dealerMarkup: 0, mark: 'A', ...design,
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

it.each([
  ['X', 'SINGLE', 'SD01', '300.00'],
  ['OXXO', 'DOUBLE', 'DD01', '500.00'],
])('includes one editable door design surcharge per %s unit before dealer markup and quantity', async (conf, kind, artworkKey, unitPrice) => {
  const { calculate, tx } = fixture('width');
  tx.frenchDoorDesign = { findUnique: jest.fn().mockResolvedValue({
    id: 11, kind, artworkKey, unitPrice: new Prisma.Decimal(unitPrice), code: 'EDITABLE-01',
  }) };
  tx.sysConf = { findUnique: jest.fn().mockResolvedValue({
    dimensionMode: 'STANDARD', isSelectableInEstimate: true, system: {
      idProduct: 1, idBrand: 1, isActive: true, allowDesign: true, brandProduct: { product: { diagramFamily: 'FRENCH_DOOR', kind: 'GLAZED_UNIT' } },
    }, config: { conf, idProduct: 1, isActive: true },
  }) };
  const qty = 3;
  const plain = await calculate('60', { qty, dealerMarkup: 25 });
  const withDesign = await calculate('60', { qty, dealerMarkup: 25, idDoorDesign: 11 });
  expect(withDesign.rate.minus(plain.rate).toFixed(2)).toBe(unitPrice);
  expect(withDesign.subtotal.minus(plain.subtotal).equals(new Decimal(unitPrice).mul(qty))).toBe(true);
  expect(withDesign.customerSubtotal.minus(plain.customerSubtotal).equals(new Decimal(unitPrice).mul(qty).mul(1.25))).toBe(true);
  expect(withDesign.idFC).toBe(plain.idFC);
});

it('uses the linked frame in calculation while preserving the existing area pricing and dimensions', async () => {
  const { calculate, tx } = fixture('width');
  tx.systemDesignOption = { findUnique: jest.fn().mockResolvedValue({
    system: { idBrand: 1, idProduct: 1, isActive: true, allowDesign: true, brandProduct: { product: { diagramFamily: 'GARAGE_DOOR' } } },
    design: { id: 11, name: 'Solid', imageUrl: null, isActive: true },
    color: { id: 12, name: 'Oak', hexCode: '#995522', isActive: true, idFrameColor: 7 },
  }) };
  tx.systemFrameColor = { findUnique: jest.fn().mockImplementation(async ({ where }) =>
    where.idSystem_idFrameColor.idFrameColor === 7 ? { idSystem: 1, idFrameColor: 7, frameColor: { isActive: true } } : null) };
  tx.systemDesignColorModifier = { findUnique: jest.fn().mockResolvedValue(null) };
  const plain = await calculate('67.0625');
  const designed = await calculate('67.0625', { idDesign: 11, idDesignColor: 12 });
  for (const field of ['rate', 'price', 'subtotal', 'customerPrice', 'customerSubtotal', 'markup', 'netProfit', 'netProfitD'] as const)
    expect(designed[field].toString()).toBe(plain[field].toString());
  expect(designed.idFC).toBe(7);
  expect(plain.idFC).toBe(1);
  expect(designed.designSnapshot?.color.idFrameColor).toBe(7);
  expect(designed.width).toBe(plain.width);
  expect(designed.height).toBe(plain.height);
  expect(designed.designSnapshot?.color.name).toBe('Oak');
});

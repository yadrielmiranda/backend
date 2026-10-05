import {
  DimensionMode,
  InstallationBillingUnit,
  InstallationLineOrigin,
  InstallationRuleMetric,
  PricingComponentType,
  Prisma,
} from '@prisma/client';
import { InstallationPricingService } from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';

const decimal = (value: number) => new Prisma.Decimal(value);

function fixture(openingWidth: number | null, units = 1) {
  // Test catalog rates, not production prices. Exercise the real component
  // resolver and pricing service with only persistence replaced by mocks.
  const service = (id: number, name: string, rate: number) => ({
    id, name, baseRate: decimal(rate), minimumCharge: decimal(0),
    estimatedMinutes: decimal(0), billingUnit: InstallationBillingUnit.UNIT,
    ruleMetric: InstallationRuleMetric.NONE, isActive: true, rules: [],
  });
  const doorService = {
    ...service(1, 'Single door installation', 0),
    ruleMetric: InstallationRuleMetric.WIDTH,
    rules: [
      { id: 11, minValue: null, minInclusive: true, maxValue: decimal(50),
        maxInclusive: false, rate: decimal(100), estimatedMinutes: null, isActive: true },
      { id: 12, minValue: decimal(50), minInclusive: true, maxValue: null,
        maxInclusive: false, rate: decimal(180), estimatedMinutes: null, isActive: true },
    ],
  };
  const sideliteService = service(2, 'Sidelite installation', 40);
  const piece = { id: 27, idSyst: 675, idConf: 3, mark: '' };
  const measurements = Array.from({ length: units }, (_, index) => ({
    id: 100 + index, pieceId: piece.id, piece, unitIndex: index + 1, label: '#2',
    widthIn: openingWidth === null ? null : decimal(openingWidth),
    heightIn: decimal(80), doorWidthIn: decimal(41), doorHeightIn: null,
    heightLeftIn: null, heightRightIn: null, legHeightIn: null,
    leftSideliteWidthIn: null, leftPanels: null,
    rightSideliteWidthIn: decimal(14), rightPanels: 1,
    panelCount: null, lengthIn: null,
  }));
  const component = (
    componentType: PricingComponentType,
    sourceConfigId: number,
    conf: string,
    installationService: typeof sideliteService | typeof doorService,
  ) => ({
    componentType, sourceConfigId, quantity: null,
    sourceSysConf: { config: { conf }, installationServices: [{ service: installationService }] },
  });
  const tx = {
    installationQuote: {
      findUnique: jest.fn().mockResolvedValue({
        id: 8, status: 'DRAFT', profileId: null, profileNameSnapshot: 'Base',
        profileAdjustmentPercent: decimal(0), profileMinimumSnapshot: decimal(0),
      }),
    },
    installationMeasurement: { findMany: jest.fn().mockResolvedValue(measurements) },
    estimateRevision: { findUnique: jest.fn().mockResolvedValue(null) },
    sysConf: {
      findUnique: jest.fn().mockResolvedValue({
        config: { conf: 'XO', fixedPanelCount: null },
        dimensionMode: DimensionMode.ECO_NOVO_DOOR,
        installationServices: [],
        pricingComponents: [
          component(PricingComponentType.DOOR, 1, 'X', doorService),
          component(PricingComponentType.SIDELITE, 2, 'O', sideliteService),
        ],
      }),
    },
    installationQuoteLine: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(async ({ data }) => data),
    },
  };
  const workflow = new InstallationWorkflowService(
    {} as never, new InstallationPricingService({} as never),
    {} as never, {} as never, {} as never, {} as never,
  );
  return {
    tx, measurements,
    rebuild: () => (workflow as any).rebuildAutomaticLines(7, 8, tx),
    lines: () => tx.installationQuoteLine.create.mock.calls.map(([{ data }]) => data),
  };
}

describe('installation automatic lines for segmented Eco Novo dimensions', () => {
  it.each([null, 55])('prices the door and sidelite separately with opening width %s', async (width) => {
    const f = fixture(width);
    await f.rebuild();

    const lines = f.lines();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => ({
      config: line.sourceConfigId,
      service: line.serviceId,
      width: line.widthIn.toNumber(),
      height: line.heightIn.toNumber(),
      amount: line.adjustedAmount.toNumber(),
    }))).toEqual([
      { config: 1, service: 1, width: 41, height: 80, amount: 100 },
      { config: 2, service: 2, width: 14, height: 80, amount: 40 },
    ]);
    expect(lines.every((line) => line.origin === InstallationLineOrigin.AUTO)).toBe(true);
    expect(lines[0].ruleId).toBe(11);
    expect(lines.reduce((sum, line) => sum + line.adjustedAmount.toNumber(), 0)).toBe(140);
    // Installation must not fill or mutate the saved material dimensions.
    expect(f.measurements[0].widthIn?.toNumber() ?? null).toBe(width);
  });

  it('creates one door and one sidelite charge for each estimate unit', async () => {
    const f = fixture(null, 2);
    await f.rebuild();

    const lines = f.lines();
    expect(lines.map((line) => [line.measurementId, line.sourceConfigId])).toEqual([
      [100, 1], [100, 2], [101, 1], [101, 2],
    ]);
    expect(lines.reduce((sum, line) => sum + line.adjustedAmount.toNumber(), 0)).toBe(280);
  });
});

import { DimensionMode, InstallationBillingUnit, InstallationRuleMetric, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationPricingService, type InstallationServiceForPricing } from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';

const dec = (value: number | string) => new Prisma.Decimal(value);
const address = { street: '100 Example St', city: 'Miami', state: 'FL', postalCode: '33101' };
const actor = { id: 7, role: { name: 'admin' } };

// Quantity and dimension distribution from the large-estimate regression. All
// identifiers, rates, accounts and addresses below are synthetic test data.
const inputs = [
  [67, 74, 63, 200, 1, 2], [67, 74, 30, 300, 2, 1], [67, 27, 96, 300, 2, 1],
  [67, 74, 63, 200, 1, 2], [67, 29, 63, 300, 2, 1], [67, 88, 63, 200, 3, 3],
  [67, 53, 27, 200, 1, 2], [67, 144, 95, 700, 4, 3], [160, 29, 63, 300, 2, 1],
  [2, 24, 120, 300, 2, 1], [4, 36, 26, 300, 2, 1], [2, 36, 67, 300, 2, 1],
  [5, 37, 24, 300, 2, 1], [5, 37, 63, 300, 2, 1], [5, 37, 29, 300, 2, 1],
  [2, 58, 24, 300, 2, 1], [1, 116, 96, 775, 1, 2], [6, 36.625, 26, 300, 2, 1],
  [1, 38, 24, 300, 2, 1], [2, 23, 23, 300, 2, 1], [2, 23, 63, 300, 2, 1],
  [2, 23, 30, 300, 2, 1], [3, 35, 23, 300, 2, 1], [1, 105, 96, 700, 4, 3],
];

function configuredService(id: number, billingUnit: InstallationBillingUnit, rate: number): InstallationServiceForPricing {
  return {
    id, name: `Synthetic installation ${id}`, description: null, billingUnit,
    ruleMetric: InstallationRuleMetric.NONE, baseRate: dec(rate), minimumCharge: dec(0),
    estimatedMinutes: dec(15), availableForRequest: true, availableForField: true,
    isActive: true, sortOrder: id, createdAt: new Date(0), updatedAt: new Date(0), rules: [],
  };
}

function fixture() {
  const services = [
    configuredService(1, 'UNIT', 100.25), configuredService(2, 'SQFT', 6.1234),
    configuredService(3, 'PANEL', 80.15), configuredService(4, 'PANEL', 90.25),
  ];
  services[0].ruleMetric = 'WIDTH';
  services[0].rules = [
    { id: 11, serviceId: 1, minValue: null, minInclusive: true, maxValue: dec(75), maxInclusive: false,
      rate: dec(100.25), estimatedMinutes: dec(20), isActive: true, sortOrder: 0, createdAt: new Date(0), updatedAt: new Date(0) },
    { id: 12, serviceId: 1, minValue: dec(75), minInclusive: true, maxValue: null, maxInclusive: false,
      rate: dec(180.35), estimatedMinutes: dec(30), isActive: true, sortOrder: 1, createdAt: new Date(0), updatedAt: new Date(0) },
  ];
  const catalog = new Map<string, any>();
  const config = (system: number, id: number, conf: string, panelCount: number, service: InstallationServiceForPricing) => {
    catalog.set(`${system}:${id}`, {
      config: { conf, fixedPanelCount: panelCount }, dimensionMode: DimensionMode.STANDARD,
      installationServices: [{ service }], pricingComponents: [],
    });
  };
  config(200, 1, 'OX', 2, services[0]); config(200, 3, 'XOX', 3, services[0]);
  config(300, 2, 'O', 1, services[1]); config(700, 4, 'XXX', 3, services[2]);
  // The same configuration ID in a different system must never reuse its service.
  config(775, 1, 'OX', 2, services[3]);

  const pieces = inputs.map(([qty, width, height, idSyst, idConf, panelCount], index) => ({
    id: index + 100, idProd: idSyst >= 700 ? 3 : 1, idBrand: idSyst === 775 ? 2 : 1,
    idSyst, idConf, idFC: 1, qty, mark: `W-${index + 1}`, width: dec(width), height: dec(height), panelCount,
    prod: { kind: 'GLAZED_UNIT', name: 'Synthetic product' }, conf: catalog.get(`${idSyst}:${idConf}`).config,
    price: dec(1000), customerPrice: dec(1100), rate: dec(900),
  }));
  const estimate: any = {
    id: 216, idUser: 7, status: { name: 'Active' }, order: null, payments: [], installationJob: null,
    user: { id: 7, role: { name: 'client' }, noInstallationDeposit: false }, pieces,
  };
  const profile = { id: 1, name: 'Synthetic profile', adjustmentPercent: new Decimal(10), minimumCharge: new Decimal(0) };
  const preparedCoverage = { address, snapshot: {
    schema: 2, revision: 1, origin: address, destination: { ...address, placeId: 'synthetic' },
    distanceMeters: 1000, maximumMiles: '300', includedMiles: '60', hoursPerDay: '8',
    range: { type: 'NONE', value: '0', dailyCharge: '0', fromMiles: '0', upToMiles: '60' },
  } };
  const measurements: any[] = [], lines: any[] = [];
  let job: any, quote: any, nextLine = 1;
  const addMeasurements = (rows: any[]) => {
    for (const row of rows) measurements.push({ ...row, id: 1000 + measurements.length,
      jobId: 7, piece: pieces.find(piece => piece.id === row.pieceId) });
  };
  const addLines = (rows: any[]) => {
    for (const row of rows) lines.push({ ...row, id: nextLine++, service: services.find(service => service.id === row.serviceId) });
  };
  const tx: any = {
    estimate: { findUnique: jest.fn(async () => estimate) },
    globalParameter: { findUnique: jest.fn(async () => ({ value: dec(100) })) },
    installationJob: { create: jest.fn(async ({ data }) => {
      addMeasurements(data.measurements?.createMany?.data ?? data.measurements?.create ?? []);
      job = { ...data, id: 7, estimate, measurements, installationAddressConfirmedAt: new Date(0) };
      quote = { ...data.quotes.create, id: 8, jobId: 7, job, lines,
        profileRateAdjustmentsSnapshot: data.quotes.create.profileRateAdjustmentsSnapshot === Prisma.DbNull
          ? null : data.quotes.create.profileRateAdjustmentsSnapshot,
        coverageSnapshot: { data: data.quotes.create.coverageSnapshot.create.data } };
      job.quotes = [quote]; return job;
    }) },
    installationMeasurement: {
      findMany: jest.fn(async ({ where }) => measurements.filter(row => !where.id?.in || where.id.in.includes(row.id))),
      createMany: jest.fn(async ({ data }) => { addMeasurements(data); return { count: data.length }; }),
    },
    installationQuote: {
      findUnique: jest.fn(async () => quote), findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }) => {
        const { coverageSnapshot, ...fields } = data;
        Object.assign(quote, fields);
        if (coverageSnapshot) quote.coverageSnapshot = { data: coverageSnapshot.update.data };
        return quote;
      }),
    },
    estimateRevision: { findUnique: jest.fn(async () => null) },
    sysConf: { findUnique: jest.fn(async ({ where }) => {
      const { idSystem, idConfig } = where.idSystem_idConfig;
      return catalog.get(`${idSystem}:${idConfig}`) ?? null;
    }) },
    installationQuoteLine: {
      deleteMany: jest.fn(async ({ where }) => {
        let count = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].quoteId === where.quoteId && lines[i].origin === where.origin &&
              (!where.measurementId?.in || where.measurementId.in.includes(lines[i].measurementId))) {
            lines.splice(i, 1); count++;
          }
        }
        return { count };
      }),
      createMany: jest.fn(async ({ data }) => { addLines(data); return { count: data.length }; }),
      create: jest.fn(async ({ data }) => { addLines([data]); return lines.at(-1); }),
      count: jest.fn(async () => lines.length),
    },
  };
  const pricing = new InstallationPricingService({} as never);
  jest.spyOn(pricing, 'resolveProfileForUser').mockResolvedValue(profile);
  const workflow: any = new InstallationWorkflowService({} as never, pricing, {} as never, {} as never, {} as never, {} as never);
  Object.assign(workflow, { coverage: { assertCurrent: jest.fn() } });
  const create = () => workflow.createRequestedInstallation(216, {
    installationAddress: address, installationAddressConfirmed: true, permitRequested: false,
  }, actor, preparedCoverage, tx);
  const rebuild = async (ids?: number[]) => {
    await workflow.rebuildAutomaticLines(7, 8, tx, ids);
    return workflow.recalculateQuoteTotals(8, tx);
  };
  const serviceFor = (piece: typeof pieces[number]) => catalog.get(`${piece.idSyst}:${piece.idConf}`).installationServices[0].service;
  return { tx, workflow, create, rebuild, pieces, estimate, measurements, lines, catalog, services, pricing, profile, preparedCoverage,
    job: () => job, quote: () => quote, serviceFor };
}

const snapshotLine = (line: any) => JSON.stringify({
  measurementId: line.measurementId, serviceId: line.serviceId, sourceSystemId: line.sourceSystemId,
  sourceConfigId: line.sourceConfigId, componentIndex: line.componentIndex, ruleId: line.ruleId,
  width: line.widthIn, height: line.heightIn, panels: line.panelCount, quantity: line.billableQuantity,
  rate: line.rate, base: line.baseAmount, adjusted: line.adjustedAmount, time: line.timeSnapshot,
});

describe('Large installation calculations preserve individual units', () => {
  it('creates all 739 independent measurements and prices every unit with its own dimensions and catalog service', async () => {
    const f = fixture(), originalPieces = JSON.stringify(f.pieces);
    await f.create();
    expect(f.pieces).toHaveLength(24); expect(f.measurements).toHaveLength(739); expect(f.lines).toHaveLength(739);
    expect(new Set(f.measurements.map(row => `${row.pieceId}:${row.unitIndex}`)).size).toBe(739);
    expect(new Set(f.lines.map(line => line.measurementId)).size).toBe(739);
    expect(f.measurements.every(row => row.status === 'PENDING' && !row.isManual)).toBe(true);
    expect(f.tx.installationJob.create.mock.calls[0][0].data.measurements.createMany.data).toHaveLength(739);
    expect(f.tx.sysConf.findUnique).toHaveBeenCalledTimes(5);
    expect(f.tx.installationQuoteLine.create).not.toHaveBeenCalled();
    expect(f.tx.installationQuoteLine.createMany.mock.calls.length).toBeLessThan(10);
    expect(f.tx.installationQuoteLine.createMany.mock.calls.every(([args]: any[]) => args.data.length > 0 && args.data.length <= 200)).toBe(true);

    let total = new Decimal(0), minutes = new Decimal(0);
    for (const piece of f.pieces) {
      const expected = f.pricing.calculateLine({ service: f.serviceFor(piece), profile: f.profile, origin: 'AUTO',
        dimensions: { widthIn: piece.width, heightIn: piece.height, panelCount: piece.panelCount, configName: piece.conf.conf } });
      const unitRows = f.measurements.filter(row => row.pieceId === piece.id);
      expect(unitRows.map(row => row.unitIndex)).toEqual(Array.from({ length: piece.qty }, (_, i) => i + 1));
      for (const unit of unitRows) {
        const line = f.lines.find(row => row.measurementId === unit.id)!;
        expect(line.baseAmount.toFixed(2)).toBe(expected.baseAmount.toFixed(2));
        expect(line.adjustedAmount.toFixed(2)).toBe(expected.adjustedAmount.toFixed(2));
        expect(line.timeSnapshot).toEqual(expected.timeSnapshot);
        expect(line.sourceSystemId).toBe(piece.idSyst); expect(line.sourceConfigId).toBe(piece.idConf);
      }
      total = total.add(new Decimal(expected.adjustedAmount.toString()).mul(piece.qty));
      minutes = minutes.add(new Decimal(expected.timeSnapshot.totalMinutes).mul(piece.qty));
    }
    expect(f.quote().total.toFixed(2)).toBe(total.toFixed(2));
    expect(f.pricing.calculateTotalMinutes(f.lines).toString()).toBe(minutes.toString());
    expect(JSON.stringify(f.pieces)).toBe(originalPieces);
    expect(f.lines.find(line => line.sourceSystemId === 775)?.serviceId).toBe(4);
    expect(f.lines.find(line => line.sourceSystemId === 200 && line.sourceConfigId === 1)?.serviceId).toBe(1);
  });

  it('remeasures one of 67 equal windows without changing the other 66 or any unrelated unit', async () => {
    const f = fixture(); await f.create();
    const selected = f.measurements.find(row => row.pieceId === 100 && row.unitIndex === 17)!;
    const others = new Map(f.lines.filter(line => line.measurementId !== selected.id).map(line => [line.measurementId, snapshotLine(line)]));
    const oldTotal = new Decimal(f.quote().total.toString());
    selected.widthIn = dec(80);
    await f.rebuild();
    expect(f.measurements).toHaveLength(739); expect(f.lines).toHaveLength(739);
    for (const line of f.lines.filter(line => line.measurementId !== selected.id)) expect(snapshotLine(line)).toBe(others.get(line.measurementId));
    const changed = f.lines.find(line => line.measurementId === selected.id)!;
    expect(changed.widthIn.toString()).toBe('80'); expect(changed.ruleId).toBe(12);
    expect(changed.adjustedAmount.toFixed(2)).toBe('198.39');
    expect(f.quote().total.toFixed(2)).toBe(oldTotal.add('88.11').toFixed(2));
    expect(f.measurements.filter(row => row.pieceId === 100 && row.id !== selected.id).every(row => row.widthIn.eq(74))).toBe(true);
    expect(f.pieces[0].width.toString()).toBe('74');
  });

  it('a targeted recalculation preserves the other saved lines and keeps user-selected work', async () => {
    const f = fixture(); await f.create();
    const selected = f.measurements.find(row => row.pieceId === 100 && row.unitIndex === 8)!;
    const otherLines = f.lines.filter(line => line.measurementId !== selected.id);
    const extra = { ...f.lines[0], id: 99999, origin: 'USER_SELECTED', measurementId: null, adjustedAmount: dec(50), baseAmount: dec(50) };
    f.lines.push(extra); selected.widthIn = dec(80);
    await f.rebuild([selected.id]);
    expect(f.lines).toHaveLength(740); expect(f.lines).toContain(extra);
    for (const line of otherLines) expect(f.lines).toContain(line);
    expect(f.lines.filter(line => line.measurementId === selected.id)).toHaveLength(1);
    expect(f.lines.find(line => line.measurementId === selected.id)?.ruleId).toBe(12);
    expect(f.tx.installationQuoteLine.deleteMany).toHaveBeenLastCalledWith({ where: { quoteId: 8, origin: 'AUTO', measurementId: { in: [selected.id] } } });
  });

  it('reloads catalog changes on the next calculation instead of keeping a stale cross-request cache', async () => {
    const f = fixture(); await f.create();
    const oldConfig = f.catalog.get('200:1');
    const oldService = oldConfig.installationServices[0].service;
    const replacementService = { ...oldService, rules: oldService.rules.map((rule: any) => ({
      ...rule, rate: rule.id === 11 ? dec(101.25) : rule.rate,
    })) };
    f.catalog.set('200:1', { ...oldConfig, installationServices: [{ service: replacementService }] });
    f.tx.sysConf.findUnique.mockClear();
    await f.rebuild();
    expect(f.tx.sysConf.findUnique).toHaveBeenCalledTimes(5);
    expect(oldService.rules[0].rate.toFixed(2)).toBe('100.25');
    expect(f.lines.find(line => line.measurementId === f.measurements[0].id)?.adjustedAmount.toFixed(2)).toBe('111.38');
  });

  it('keeps a failed request inside the bounded agreement transaction and retries without partial units', async () => {
    const f = fixture();
    f.tx.$queryRaw = jest.fn(async () => [{ id: 216, paymentPlanSnapshot: null }]);
    f.tx.estimateAgreement = { findMany: jest.fn(async () => []) };
    // Simulate the database transaction boundary, while running the actual
    // requestInstallation, agreement lock/helper and automatic-line calculation.
    const prisma = { $transaction: jest.fn(async (work: (client: any) => Promise<any>) => {
      const previousMeasurements = [...f.measurements], previousLines = [...f.lines];
      try {
        return await work(f.tx);
      } catch (error) {
        f.measurements.splice(0, f.measurements.length, ...previousMeasurements);
        f.lines.splice(0, f.lines.length, ...previousLines);
        throw error;
      }
    }) };
    const log = jest.fn();
    Object.assign(f.workflow, { prisma, logs: { log } });
    jest.spyOn(f.workflow, 'prepareInstallationCoverage').mockResolvedValue(f.preparedCoverage);
    const findJob = jest.spyOn(f.workflow, 'findJob').mockImplementation(async () => f.job());
    const notify = jest.spyOn(f.workflow, 'notifyInstallationOwner').mockResolvedValue(undefined);
    const writeBatch = f.tx.installationQuoteLine.createMany.getMockImplementation();
    f.tx.installationQuoteLine.createMany.mockImplementationOnce(writeBatch)
      .mockRejectedValueOnce(new Error('Synthetic database batch failure'));
    const dto = { installationAddress: address, installationAddressConfirmed: true, permitRequested: false };

    await expect(f.workflow.requestInstallation(216, dto, actor)).rejects.toThrow('Synthetic database batch failure');
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { maxWait: 15000, timeout: 60000 });
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.tx.installationJob.create).toHaveBeenCalledTimes(1);
    expect(f.tx.installationQuoteLine.createMany).toHaveBeenCalledTimes(2);
    expect(f.tx.installationQuote.update).not.toHaveBeenCalled();
    expect(f.tx.estimateAgreement.findMany).not.toHaveBeenCalled();
    expect(f.measurements).toHaveLength(0); expect(f.lines).toHaveLength(0);
    expect(log).not.toHaveBeenCalled(); expect(findJob).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();

    const retriedJob = await f.workflow.requestInstallation(216, dto, actor);
    expect(retriedJob).toBe(f.job());
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.tx.estimateAgreement.findMany).toHaveBeenCalledTimes(1);
    expect(f.measurements).toHaveLength(739); expect(f.lines).toHaveLength(739);
    expect(new Set(f.measurements.map(row => `${row.pieceId}:${row.unitIndex}`)).size).toBe(739);
    expect(log).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed batch and does not calculate totals from partially written automatic lines', async () => {
    const f = fixture(); await f.create();
    const recalculations = f.tx.installationQuote.update.mock.calls.length;
    f.tx.installationQuoteLine.createMany.mockImplementationOnce(async ({ data }: any) => {
      for (const line of data) f.lines.push(line);
      return { count: data.length };
    }).mockRejectedValueOnce(new Error('Synthetic database batch failure'));
    await expect(f.rebuild()).rejects.toThrow('Synthetic database batch failure');
    expect(f.tx.installationQuote.update.mock.calls).toHaveLength(recalculations);
  });
});

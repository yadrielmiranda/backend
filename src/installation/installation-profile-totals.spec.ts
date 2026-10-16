import { Prisma } from '@prisma/client';
import { InstallationPricingService, type InstallationServiceForPricing } from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';
import { presentInstallationPricing } from './installation-pricing.interceptor';

const dec = (value: number | string) => new Prisma.Decimal(value);
const adjustments = { schema: 1, adjustments: [] };

function fixture(options: { base?: number; sale?: number; minimum?: number; serviceMinimum?: number; legacy?: boolean; coverage?: boolean } = {}) {
  const quote: any = {
    id: 1, jobId: 1, version: 1, profileId: 2, profileNameSnapshot: 'Customers',
    profileAdjustmentPercent: dec(20), profileMinimumSnapshot: dec(options.minimum ?? 500),
    profileRateAdjustmentsSnapshot: options.legacy ? null : adjustments,
    lines: [{ serviceId: 3, serviceNameSnapshot: 'Installation', origin: 'AUTO',
      baseAmount: dec(options.base ?? 300), adjustedAmount: dec(options.sale ?? 360),
      service: { minimumCharge: dec(options.serviceMinimum ?? 0) }, timeSnapshot: null }],
    job: { installationAddressConfirmedAt: null },
    coverageSnapshot: options.coverage ? { data: { schema: 1, range: { type: 'PERCENTAGE', value: '10' } } } : null,
  };
  const tx: any = { installationQuote: {
    findUnique: jest.fn().mockResolvedValue(quote),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(async ({ data }) => {
      const { coverageSnapshot, ...fields } = data;
      Object.assign(quote, fields);
      if (coverageSnapshot) quote.coverageSnapshot = { data: coverageSnapshot.update.data };
      return quote;
    }),
  } };
  const workflow: any = new InstallationWorkflowService({} as never, new InstallationPricingService({} as never),
    {} as never, {} as never, {} as never, {} as never);
  return { quote, tx, workflow, recalculate: (minimums?: unknown) => workflow.recalculateQuoteTotals(1, tx, minimums) };
}

describe('Provider minimums and independent installation profile increases', () => {
  it('adds the profile margin after reaching the provider minimum: 300 -> 500 + 60', async () => {
    const f = fixture();
    await f.recalculate();
    expect(f.quote.total.toFixed(2)).toBe('560.00');
    expect(f.quote.providerCostSnapshot).toEqual({ schema: 1, baseSubtotal: '300.00',
      serviceMinimumAdjustment: '0.00', minimumAdjustment: '200.00', installationSurcharge: '0.00', total: '500.00' });
    expect(f.quote.baseSubtotal.toFixed(2)).toBe('300.00');
    expect(f.quote.adjustedSubtotal.toFixed(2)).toBe('360.00');
    await f.recalculate();
    expect(f.quote.total.toFixed(2)).toBe('560.00');
  });

  it('does not absorb increases into service minimums', async () => {
    const f = fixture({ base: 100, sale: 120, minimum: 0, serviceMinimum: 200 });
    await f.recalculate();
    expect(f.quote.serviceMinimumAdjustment.toFixed(2)).toBe('100.00');
    expect(f.quote.providerCostSnapshot.total).toBe('200.00');
    expect(f.quote.total.toFixed(2)).toBe('220.00');
  });

  it('uses the full base amount once it exceeds the provider minimum', async () => {
    const f = fixture({ base: 600, sale: 720 });
    await f.recalculate();
    expect(f.quote.providerCostSnapshot.total).toBe('600.00');
    expect(f.quote.minimumAdjustment.toFixed(2)).toBe('0.00');
    expect(f.quote.total.toFixed(2)).toBe('720.00');
  });

  it('keeps a profile without increases at the provider price', async () => {
    const f = fixture({ sale: 300 });
    await f.recalculate();
    expect(f.quote.providerCostSnapshot.total).toBe('500.00');
    expect(f.quote.total.toFixed(2)).toBe('500.00');
  });

  it('calculates coverage on provider amounts without creating another markup', async () => {
    const f = fixture({ coverage: true });
    await f.recalculate();
    expect(f.quote.installationSurcharge.toFixed(2)).toBe('50.00');
    expect(f.quote.providerCostSnapshot.total).toBe('550.00');
    expect(f.quote.total.toFixed(2)).toBe('610.00');
  });

  it('combines calculated lines, grouped service minimums, the global minimum and coverage before adding increases', async () => {
    const f = fixture({ minimum: 600, coverage: true });
    f.quote.profileRateAdjustmentsSnapshot = { schema: 1, adjustments: [
      { serviceId: 3, ruleId: null, type: 'PERCENT', value: '10' },
      { serviceId: 4, ruleId: null, type: 'AMOUNT', value: '5' },
    ] };
    const service = (id: number, rate: number, minimum: number): InstallationServiceForPricing => ({
      id, name: `Service ${id}`, description: null, billingUnit: id === 4 ? 'PANEL' : 'UNIT', ruleMetric: 'NONE',
      baseRate: dec(rate), minimumCharge: dec(minimum), estimatedMinutes: dec(15), availableForRequest: true,
      availableForField: true, isActive: true, sortOrder: 0, createdAt: new Date(0), updatedAt: new Date(0), rules: [],
    });
    const first = service(3, 100, 400), second = service(4, 25, 100);
    const before = JSON.stringify([first, second]);
    const pricing = new InstallationPricingService({} as never);
    const selected = f.workflow.profileFromQuote(f.quote);
    f.quote.lines = [
      { ...pricing.calculateLine({ service: first, profile: selected, dimensions: {}, origin: 'AUTO' }), service: first },
      { ...pricing.calculateLine({ service: first, profile: selected, dimensions: {}, occurrences: 2, origin: 'AUTO' }), service: first },
      { ...pricing.calculateLine({ service: second, profile: selected, dimensions: { panelCount: 2 }, origin: 'AUTO' }), service: second },
    ];
    await f.recalculate();
    expect(f.quote.baseSubtotal.toFixed(2)).toBe('350.00');
    expect(f.quote.adjustedSubtotal.toFixed(2)).toBe('390.00');
    expect(f.quote.serviceMinimumsSnapshot).toEqual([
      { serviceId: 3, serviceName: 'Service 3', minimumCharge: '400.00', calculatedAmount: '300.00', adjustment: '100.00' },
      { serviceId: 4, serviceName: 'Service 4', minimumCharge: '100.00', calculatedAmount: '50.00', adjustment: '50.00' },
    ]);
    expect(f.quote.providerCostSnapshot).toEqual({ schema: 1, baseSubtotal: '350.00',
      serviceMinimumAdjustment: '150.00', minimumAdjustment: '100.00', installationSurcharge: '60.00', total: '660.00' });
    expect(f.quote.total.toFixed(2)).toBe('700.00');
    await f.recalculate();
    expect(f.quote.total.toFixed(2)).toBe('700.00');
    expect(JSON.stringify([first, second])).toBe(before);
  });

  it('does not multiply provider daily charges or coverage by a profile increase', async () => {
    const f = fixture();
    f.quote.lines[0].timeSnapshot = { schema: 1, totalMinutes: '481' };
    f.quote.coverageSnapshot = { data: { schema: 2, hoursPerDay: '8',
      range: { type: 'PERCENTAGE', value: '10', dailyCharge: '125.25' } } };
    await f.recalculate();
    expect(f.quote.providerCostSnapshot.total).toBe('800.50');
    expect(f.quote.installationSurcharge.toFixed(2)).toBe('300.50');
    expect(f.quote.total.toFixed(2)).toBe('860.50');
    expect(f.quote.coverageSnapshot.data.calculation).toMatchObject({
      installationDays: '2', oneTimeCharge: '50.00', dailyChargeTotal: '250.50',
    });
  });

  it('applies a frozen profile to new and recalculated manual lines while keeping current provider rates separate', async () => {
    const f = fixture({ minimum: 0 });
    Object.assign(f.quote, { status: 'DRAFT', lines: [], profileRateAdjustmentsSnapshot: {
      schema: 1, adjustments: [{ serviceId: 3, ruleId: null, type: 'PERCENT', value: '20' }],
    } });
    const configured = { id: 3, name: 'Field service', billingUnit: 'UNIT', ruleMetric: 'NONE',
      baseRate: dec(100), minimumCharge: dec(0), estimatedMinutes: dec(15), rules: [],
      isActive: true, availableForRequest: true, availableForField: true };
    f.tx.installationService = { findUnique: jest.fn(async () => configured) };
    f.tx.installationPriceProfile = { findUnique: jest.fn(() => { throw new Error('Frozen profiles must not be reloaded'); }) };
    f.tx.user = { findUnique: jest.fn(() => { throw new Error('The editor profile must not be resolved'); }) };
    f.tx.installationQuoteLine = {
      aggregate: jest.fn(async () => ({ _max: { sortOrder: -1 } })),
      create: jest.fn(async ({ data }) => { const saved = { ...data, id: 10, service: configured }; f.quote.lines.push(saved); return saved; }),
      findMany: jest.fn(async () => [...f.quote.lines]),
      deleteMany: jest.fn(async () => { f.quote.lines = []; }),
    };
    const created = await f.workflow.addLineInTransaction(1, { serviceId: 3, occurrences: 2 }, 'FIELD_ADDED', f.tx);
    expect(created.baseAmount.toFixed(2)).toBe('200.00');
    expect(created.adjustedAmount.toFixed(2)).toBe('240.00');
    configured.baseRate = dec(200);
    const providerBeforeRebuild = JSON.stringify(configured);
    await f.workflow.rebuildManualLines(1, f.tx);
    expect(f.quote.lines[0].rate.toFixed(4)).toBe('200.0000');
    expect(f.quote.lines[0].saleRate.toFixed(4)).toBe('240.0000');
    expect(f.quote.lines[0].baseAmount.toFixed(2)).toBe('400.00');
    expect(f.quote.lines[0].adjustedAmount.toFixed(2)).toBe('480.00');
    expect(f.quote.profileRateAdjustmentsSnapshot.adjustments[0].value).toBe('20');
    expect(JSON.stringify(configured)).toBe(providerBeforeRebuild);
    expect(created.rate.toFixed(4)).toBe('100.0000');
    expect(created.adjustedAmount.toFixed(2)).toBe('240.00');
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    expect(f.tx.installationPriceProfile.findUnique).not.toHaveBeenCalled();
  });

  it('uses frozen service minimums when a revision preserves existing scope', async () => {
    const f = fixture({ base: 100, sale: 120, minimum: 0, serviceMinimum: 900 });
    await f.recalculate([{ serviceId: 3, minimumCharge: '200.00' }]);
    expect(f.quote.providerCostSnapshot.total).toBe('200.00');
    expect(f.quote.total.toFixed(2)).toBe('220.00');
  });

  it('does not keep an obsolete minimum top-up when revised provider services exceed the minimum', async () => {
    const f = fixture({ base: 600, sale: 720 });
    f.quote.version = 2;
    f.tx.installationQuote.findFirst.mockResolvedValue({ minimumAdjustment: dec(200) });
    await f.recalculate();
    expect(f.quote.providerCostSnapshot.minimumAdjustment).toBe('0.00');
    expect(f.quote.providerCostSnapshot.total).toBe('600.00');
    expect(f.quote.total.toFixed(2)).toBe('720.00');
  });

  it('keeps historical quotes on their original minimum calculation', async () => {
    const f = fixture({ legacy: true });
    await f.recalculate();
    expect(f.quote.total.toFixed(2)).toBe('500.00');
    expect(f.quote.minimumAdjustment.toFixed(2)).toBe('140.00');
    expect(f.quote.providerCostSnapshot).toBeUndefined();
  });

  it('reads frozen profile adjustments without consulting the mutable catalog', () => {
    const f = fixture();
    f.quote.profileRateAdjustmentsSnapshot = { schema: 1, adjustments: [{ serviceId: 3, ruleId: 5, type: 'AMOUNT', value: '20' }] };
    expect(f.workflow.profileFromQuote(f.quote).rateAdjustments).toEqual(f.quote.profileRateAdjustmentsSnapshot);
    f.quote.profileRateAdjustmentsSnapshot = null;
    expect(f.workflow.profileFromQuote(f.quote).rateAdjustments).toBeUndefined();
  });

  it('copies frozen provider costs and rate adjustments into a new quote revision', async () => {
    const f = fixture();
    await f.recalculate();
    const saved = { ...f.quote, status: 'APPROVED', total: dec(560), lines: [{
      ...f.quote.lines[0], saleRate: dec(120), rateAdjustmentSnapshot: { schema: 1, type: 'PERCENT', value: '20' },
    }] };
    f.tx.installationQuote.findFirst.mockResolvedValue(saved);
    f.tx.payment = { findFirst: jest.fn().mockResolvedValue(null) };
    f.tx.installationJob = { findUnique: jest.fn().mockResolvedValue({ estimate: { order: null } }) };
    f.tx.installationQuote.create = jest.fn(async ({ data }) => data);
    const revision = await f.workflow.ensureDraftQuote(1, 7, f.tx);
    expect(revision.profileRateAdjustmentsSnapshot).toEqual(adjustments);
    expect(revision.providerCostSnapshot).toEqual(saved.providerCostSnapshot);
    expect(revision.lines.create[0].rateAdjustmentSnapshot).toEqual(saved.lines[0].rateAdjustmentSnapshot);
    expect(revision.lines.create[0].saleRate.toString()).toBe('120');
  });

  it.each(['dealer', 'client', 'operator', 'technician'])('keeps supplier cost and margin private from %s installation responses', async role => {
    const f = fixture();
    await f.recalculate();
    const result = presentInstallationPricing({ ...f.quote, installationProcessingSummary: { provider: { collected: '500.00' } } },
      { id: 7, role: { name: role } } as any);
    expect(result.total.toFixed(2)).toBe('560.00');
    expect(result).not.toHaveProperty('providerCostSnapshot');
    expect(result).not.toHaveProperty('profileRateAdjustmentsSnapshot');
    expect(result).not.toHaveProperty('installationProcessingSummary');
  });
});

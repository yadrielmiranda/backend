import { BadRequestException } from '@nestjs/common';
import {
  InstallationBillingUnit,
  InstallationLineOrigin,
  InstallationRuleMetric,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { buildEstimateInstallationSummary } from '@/estimates/reporting/estimate-installation-summary';
import { agreementScopes } from '@/contracts/agreement-content';
import {
  InstallationCoverageCalculationService,
  installationSurchargeCalculation,
  type CoverageSnapshot,
} from './installation-coverage-calculation.service';
import {
  InstallationPricingService,
  type InstallationServiceForPricing,
  type InstallationPricingDimensions,
} from './installation-pricing.service';
import { InstallationWorkflowService } from './installation-workflow.service';

const dec = (value: string | number) => new Prisma.Decimal(value);
const pricing = new InstallationPricingService({} as never);
const profile = {
  id: null, name: 'Base', adjustmentPercent: new Decimal(0), minimumCharge: new Decimal(0),
};
const address = { street: '100 Example St', city: 'Miami', state: 'FL', postalCode: '33101' };
const coverage = (): CoverageSnapshot => ({
  schema: 2, revision: 7, origin: address, destination: { ...address, placeId: 'private' },
  distanceMeters: 160934, maximumMiles: '300', includedMiles: '60', hoursPerDay: '8',
  range: { type: 'FIXED', value: '500', dailyCharge: '200', fromMiles: '60', upToMiles: '150' },
});
function service(overrides: Partial<InstallationServiceForPricing> = {}): InstallationServiceForPricing {
  return {
    id: 1, name: 'Installation', description: null,
    billingUnit: InstallationBillingUnit.UNIT, ruleMetric: InstallationRuleMetric.NONE,
    baseRate: dec(100), minimumCharge: dec(0), estimatedMinutes: dec(20),
    availableForRequest: true, availableForField: true, isActive: true, sortOrder: 0,
    createdAt: new Date(), updatedAt: new Date(), rules: [], ...overrides,
  };
}
function line(
  configured = service(),
  dimensions: InstallationPricingDimensions = {},
  occurrences = 1,
  origin: InstallationLineOrigin = InstallationLineOrigin.AUTO,
) {
  return pricing.calculateLine({ service: configured, dimensions, occurrences, origin, profile });
}
const rule = (id: number, min: number | null, max: number | null, minutes: number | null) => ({
  id, serviceId: 1, minValue: min == null ? null : dec(min), maxValue: max == null ? null : dec(max),
  minInclusive: true, maxInclusive: false, rate: dec(100), estimatedMinutes: minutes == null ? null : dec(minutes),
  sortOrder: id, isActive: true, createdAt: new Date(), updatedAt: new Date(),
});

describe('Installation duration and daily charge', () => {
  it.each([
    [InstallationBillingUnit.UNIT, {}, 4, '80'],
    [InstallationBillingUnit.PANEL, { panelCount: 3 }, 2, '120'],
    [InstallationBillingUnit.SQFT, { areaSqFt: 8.5 }, 2, '340'],
    [InstallationBillingUnit.SQFT, { widthIn: 48, heightIn: 60, configName: 'Triangle' }, 2, '400'],
    [InstallationBillingUnit.SQFT_RECTANGULAR, { widthIn: 48, heightIn: 60, configName: 'Triangle' }, 2, '800'],
    [InstallationBillingUnit.LINEAR_FOOT, { lengthIn: 30 }, 3, '150'],
  ] as const)('uses the real %s quantity and occurrences', (billingUnit, dimensions, occurrences, expected) => {
    const calculated = line(service({ billingUnit }), dimensions, occurrences);
    expect(calculated.timeSnapshot.totalMinutes).toBe(expected);
    expect(pricing.calculateTotalMinutes([calculated]).toString()).toBe(expected);
  });

  it('does not round the billable quantity before calculating duration', () => {
    const calculated = line(service({ billingUnit: 'LINEAR_FOOT', estimatedMinutes: dec(12) }), { lengthIn: 1 });
    expect(calculated.billableQuantity.toString()).toBe('0.0833');
    expect(calculated.timeSnapshot.totalMinutes).toBe('1');
  });

  it('uses the matching price range time, including explicit zero, and otherwise inherits the base', () => {
    const configured = service({ ruleMetric: 'WIDTH', rules: [rule(1, null, 48, null), rule(2, 48, null, 90)] });
    expect(line(configured, { widthIn: '47.999' }, 2).timeSnapshot).toMatchObject({ source: 'SERVICE', totalMinutes: '40' });
    expect(line(configured, { widthIn: 48 }, 2).timeSnapshot).toMatchObject({ source: 'RULE', totalMinutes: '180' });
    configured.rules[1].estimatedMinutes = dec(0);
    expect(line(configured, { widthIn: 48 }, 2).timeSnapshot).toMatchObject({ source: 'RULE', totalMinutes: '0' });
    configured.rules[1].estimatedMinutes = null;
    expect(line(configured, { widthIn: 48 }, 2).timeSnapshot).toMatchObject({ source: 'SERVICE', totalMinutes: '40' });
  });

  it('keeps prices, service minimums and profile adjustments independent from duration', () => {
    const calculated = pricing.calculateLine({
      service: service({ minimumCharge: dec(9000) }), origin: 'AUTO', dimensions: {}, occurrences: 2,
      profile: { ...profile, adjustmentPercent: new Decimal(50), minimumCharge: new Decimal(10000) },
    });
    expect(calculated.adjustedAmount.toString()).toBe('300');
    expect(calculated.timeSnapshot.totalMinutes).toBe('40');
  });

  it('accepts zero service time and does not add minimum days', () => {
    const calculated = line(service({ estimatedMinutes: dec(0) }), {}, 10);
    const total = pricing.calculateTotalMinutes([calculated]);
    expect(installationSurchargeCalculation(new Decimal(1000), coverage(), total)).toEqual({
      totalMinutes: '0', installationDays: '0', oneTimeCharge: '500.00', dailyChargeTotal: '0.00', totalCharge: '500.00',
    });
  });

  it.each([
    ['0.0001', '8', '1'], ['480', '8', '1'], ['480.0001', '8', '2'], ['960', '8', '2'],
    ['450', '7.5', '1'], ['450.0001', '7.5', '2'], ['0.6', '0.01', '1'], ['0.6001', '0.01', '2'],
  ])('rounds %s minutes up once with a %s-hour workday', (minutes, hoursPerDay, expected) => {
    const result = installationSurchargeCalculation(new Decimal(1000), { ...coverage(), hoursPerDay }, new Decimal(minutes));
    expect(result.installationDays).toBe(expected);
    expect(result.dailyChargeTotal).toBe(new Decimal(expected).mul(200).toFixed(2));
  });

  it('sums automatic, requested and field work before rounding the total into days', () => {
    const configured = service({ estimatedMinutes: dec(160) });
    const total = pricing.calculateTotalMinutes([
      line(configured), line(configured, {}, 1, 'USER_SELECTED'), line(configured, {}, 1, 'FIELD_ADDED'),
    ]);
    expect(total.toString()).toBe('480');
    expect(installationSurchargeCalculation(new Decimal(1000), coverage(), total).installationDays).toBe('1');
  });

  it('keeps both charges at zero in the included zone regardless of duration', () => {
    const saved = coverage();
    saved.range.type = 'NONE';
    expect(installationSurchargeCalculation(new Decimal(1000), saved, new Decimal(1500))).toMatchObject({
      installationDays: '4', oneTimeCharge: '0.00', dailyChargeTotal: '0.00', totalCharge: '0.00',
    });
  });

  it('adds the daily amount to a single percentage charge, with cent rounding', () => {
    const saved = coverage();
    saved.range.type = 'PERCENTAGE'; saved.range.value = '15'; saved.range.dailyCharge = '125.25';
    expect(installationSurchargeCalculation(new Decimal('123.45'), saved, new Decimal(481))).toMatchObject({
      oneTimeCharge: '18.52', dailyChargeTotal: '250.50', totalCharge: '269.02',
    });
  });

  it('supports a zero daily rate and a zero one-time rate independently', () => {
    const saved = coverage();
    saved.range.dailyCharge = '0';
    expect(installationSurchargeCalculation(new Decimal(1000), saved, new Decimal(481)).totalCharge).toBe('500.00');
    saved.range.dailyCharge = '200'; saved.range.value = '0';
    expect(installationSurchargeCalculation(new Decimal(1000), saved, new Decimal(481)).totalCharge).toBe('400.00');
  });

  it.each([[96560, '0.00', '0.00'], [96561, '500.00', '400.00'], [241401, '500.00', '400.00'], [241402, '1000.00', '600.00']])(
    'charges only the matching distance range at %s meters', async (distanceMeters, oneTimeCharge, dailyChargeTotal) => {
      const db: any = { installationCoverage: { findUnique: jest.fn().mockResolvedValue({
        revision: 3, originStreet: address.street, originCity: address.city, originState: 'FL', originPostalCode: address.postalCode,
        hoursPerDay: dec(8), maxDistanceMiles: dec(300), includedMiles: dec(60), ranges: [
          { fromMiles: '60', upToMiles: '150', chargeType: 'FIXED', value: '500', dailyCharge: '200' },
          { fromMiles: '150', upToMiles: '300', chargeType: 'FIXED', value: '1000', dailyCharge: '300' },
        ],
      }) } };
      const addresses: any = { validateDeliveryAddress: jest.fn().mockResolvedValue({ ...address, placeId: 'test' }) };
      const routes: any = { calculateDrivingRoute: jest.fn().mockResolvedValue({ distanceMeters }) };
      const prepared = await new InstallationCoverageCalculationService(db, addresses, routes).prepare(address);
      expect(installationSurchargeCalculation(new Decimal(1000), prepared.snapshot, new Decimal(540))).toMatchObject({ oneTimeCharge, dailyChargeTotal });
      expect(routes.calculateDrivingRoute).toHaveBeenCalledTimes(1);
    },
  );

  it('does not introduce daily charges into historical coverage snapshots', () => {
    const saved = { ...coverage(), schema: 1 } as CoverageSnapshot;
    expect(installationSurchargeCalculation(new Decimal(1000), saved, new Decimal(2000)).totalCharge).toBe('500.00');
    expect(pricing.calculateTotalMinutes([{ timeSnapshot: null }, {}]).toString()).toBe('0');
  });

  it('refuses amounts beyond the money column limit before writing', () => {
    const saved = coverage(); saved.range.dailyCharge = '9999999999.99';
    expect(() => installationSurchargeCalculation(new Decimal(1000), saved, new Decimal(481))).toThrow(BadRequestException);
  });
});

function workflowFixture(snapshot: CoverageSnapshot | null = coverage()) {
  const automatic = service({ baseRate: dec(1000), estimatedMinutes: dec(480) });
  const extra = service({ id: 2, name: 'Extra', baseRate: dec(200), minimumCharge: dec(300), estimatedMinutes: dec(30) });
  const quote: any = {
    id: 1, jobId: 1, version: 1, status: 'DRAFT', profileId: null, profileNameSnapshot: 'Base',
    profileAdjustmentPercent: dec(0), profileMinimumSnapshot: dec(0), serviceMinimumsSnapshot: null,
    lines: [
      { ...line(automatic), service: automatic },
      { ...line(extra, {}, 1, 'USER_SELECTED'), service: extra },
    ],
    job: { installationAddressConfirmedAt: snapshot ? new Date() : null },
    coverageSnapshot: snapshot ? { data: snapshot } : null,
  };
  const tx: any = {
    installationQuote: {
      findUnique: jest.fn(async () => quote),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }) => {
        const { coverageSnapshot, ...fields } = data;
        Object.assign(quote, fields);
        if (coverageSnapshot) quote.coverageSnapshot = { data: coverageSnapshot.update.data };
        return quote;
      }),
    },
  };
  const coverageService = { prepare: jest.fn(), assertCurrent: jest.fn() };
  const db = { installationCoverage: { findUnique: jest.fn() } };
  const workflow: any = new InstallationWorkflowService(db as never, pricing, { log: jest.fn() } as never, {} as never, {} as never, {} as never);
  Object.assign(workflow, { coverage: coverageService });
  const recalculate = () => workflow.recalculateQuoteTotals(quote.id, tx);
  return { quote, tx, workflow, recalculate, automatic, extra, coverageService, db };
}

describe('Daily charge connected to quote totals', () => {
  it('calculates legacy automatic-line times when an unpaid request changes to a new address', async () => {
    const f = workflowFixture({ ...coverage(), schema: 1 });
    f.quote.lines = [{ ...line(f.automatic), timeSnapshot: null, service: f.automatic }];
    const job: any = {
      id: 1, estimateId: 1, status: 'DEPOSIT_PAYMENT_PENDING', quotes: [f.quote],
      installationAddress: address, depositAmountSnapshot: dec(250), payments: [], permit: null,
      estimate: { id: 1, idUser: 7, number: '1', payments: [], order: null, status: { name: 'Active' }, user: { role: { name: 'dealer' } } },
    };
    const destination = { ...address, street: '200 Other St' };
    const saved = { ...coverage(), destination: { ...destination, placeId: 'new' } };
    jest.spyOn(f.workflow, 'findJob').mockResolvedValue(job);
    jest.spyOn(f.workflow, 'prepareInstallationCoverage').mockResolvedValue({ address: destination, snapshot: saved });
    jest.spyOn(f.workflow, 'withAgreementJobTransaction').mockImplementation(async (_id, work: any) => work(f.tx));
    f.tx.installationJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn(async ({ data }) => Object.assign(job, data)),
    };
    f.tx.installationQuoteCoverageSnapshot = {
      upsert: jest.fn(async ({ update }) => { f.quote.coverageSnapshot = { data: update.data }; }),
    };
    f.tx.installationQuoteLine = { deleteMany: jest.fn(), count: jest.fn().mockResolvedValue(1) };
    const rebuild = jest.spyOn(f.workflow, 'rebuildAutomaticLines').mockImplementation(async () => {
      f.quote.lines = [{ ...line(f.automatic), service: f.automatic }];
    });
    await f.workflow.updateInstallationRequest(1, {
      installationAddress: destination, installationAddressConfirmed: true, permitRequested: false, selectedServices: [],
    }, { id: 7, role: { name: 'dealer' } });
    expect(rebuild).toHaveBeenCalledWith(1, 1, f.tx);
    expect(f.quote.coverageSnapshot.data.calculation).toMatchObject({ totalMinutes: '480', installationDays: '1', dailyChargeTotal: '200.00' });
    expect(f.quote.total.toString()).toBe('1700');
  });

  it('persists the calculation, keeps frozen times and tariffs, and recalculates without accumulation or Google', async () => {
    const f = workflowFixture();
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('2200');
    expect(f.quote.installationSurcharge.toString()).toBe('900');
    expect(f.quote.coverageSnapshot.data.calculation).toEqual({
      totalMinutes: '510', installationDays: '2', oneTimeCharge: '500.00', dailyChargeTotal: '400.00', totalCharge: '900.00',
    });
    f.automatic.estimatedMinutes = dec(5000); f.extra.estimatedMinutes = dec(6000);
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('2200');
    expect(f.quote.coverageSnapshot.data.calculation.totalMinutes).toBe('510');
    const additional = service({ id: 3, estimatedMinutes: dec(480) });
    f.quote.lines.push({ ...line(additional, {}, 1, 'FIELD_ADDED'), service: additional });
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('2500');
    expect(f.quote.coverageSnapshot.data.calculation.installationDays).toBe('3');
    f.quote.lines.pop();
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('2200');
    expect(f.coverageService.prepare).not.toHaveBeenCalled();
    expect(f.db.installationCoverage.findUnique).not.toHaveBeenCalled();
  });

  it('includes extra-service time without including its price or minimum in the percentage base', async () => {
    const saved = coverage(); saved.range.type = 'PERCENTAGE'; saved.range.value = '15';
    const f = workflowFixture(saved);
    await f.recalculate();
    expect(f.quote.coverageSnapshot.data.calculation).toMatchObject({
      totalMinutes: '510', oneTimeCharge: '150.00', dailyChargeTotal: '400.00',
    });
    expect(f.quote.total.toString()).toBe('1850');
  });

  it('publishes one combined surcharge and preserves the commercial summary and contract amount', async () => {
    const f = workflowFixture(); await f.recalculate();
    const summary = buildEstimateInstallationSummary({ status: 'REQUESTED', installationAddress: address, quotes: [f.quote], permit: null } as any)!;
    expect(summary).toMatchObject({ installationSurcharge: '900.00', installationAmount: '1900.00', installationTotal: '2200.00' });
    expect(summary.additionalServices[0].amount).toBe('300.00');
    const scopes = agreementScopes({ installationSummary: summary });
    expect(scopes.charges.total).toBe('2200.00');
    expect(scopes.charges.lines.filter(item => item.description === 'Installation surcharge')).toEqual([
      expect.objectContaining({ amount: '900.00' }),
    ]);
    for (const role of ['client', 'dealer', 'operator'] as const) {
      const response = presentApiResponse({ quotes: [f.quote] }, { id: 7, role: { name: role } });
      expect(response.quotes[0].installationSurcharge.toString()).toBe('900');
      expect(JSON.stringify(response)).not.toMatch(/timeSnapshot|coverageSnapshot|minutesPerUnit|installationDays|dailyCharge|hoursPerDay/);
    }
  });

  it('leaves both surcharges zero for included addresses after actual quote recalculation', async () => {
    const saved = coverage(); saved.range.type = 'NONE';
    const f = workflowFixture(saved); await f.recalculate();
    expect(f.quote.installationSurcharge.toString()).toBe('0');
    expect(f.quote.total.toString()).toBe('1300');
  });

  it('keeps only the one-time charge when all configured times are zero', async () => {
    const f = workflowFixture();
    for (const current of f.quote.lines) {
      current.service.estimatedMinutes = dec(0);
      current.timeSnapshot = line(current.service).timeSnapshot;
    }
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('1800');
    expect(f.quote.coverageSnapshot.data.calculation.installationDays).toBe('0');
  });

  it('preserves legacy totals without daily repricing or coverage migration', async () => {
    const f = workflowFixture({ ...coverage(), schema: 1 });
    const saved = f.quote.coverageSnapshot;
    await f.recalculate();
    expect(f.quote.total.toString()).toBe('1800');
    expect(f.quote.coverageSnapshot).toBe(saved);
    expect(f.tx.installationQuote.update.mock.calls[0][0].data).not.toHaveProperty('coverageSnapshot');
    const legacy = workflowFixture(null); await legacy.recalculate();
    expect(legacy.quote.total.toString()).toBe('1300');
  });

  it('copies time and coverage snapshots to a new draft without changing the approved quote', async () => {
    const f = workflowFixture(); await f.recalculate();
    f.quote.status = 'APPROVED'; f.quote.approvedAt = new Date();
    const before = JSON.stringify(f.quote);
    f.tx.installationQuote.findFirst.mockResolvedValue(f.quote);
    f.tx.installationQuote.update.mockClear();
    f.tx.installationQuote.create = jest.fn(async ({ data }) => ({ id: 2, ...data }));
    f.tx.payment = { findFirst: jest.fn().mockResolvedValue(null) };
    f.tx.installationJob = { findUnique: jest.fn().mockResolvedValue({ estimate: { order: null }, permit: null }) };
    const draft = await f.workflow.ensureDraftQuote(1, 7, f.tx);
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(2);
    expect(draft.coverageSnapshot.create.data).toEqual(f.quote.coverageSnapshot.data);
    expect(draft.lines.create.map(item => item.timeSnapshot)).toEqual(f.quote.lines.map(item => item.timeSnapshot));
    expect(f.tx.installationQuote.update).not.toHaveBeenCalled();
    expect(JSON.stringify(f.quote)).toBe(before);
  });
});

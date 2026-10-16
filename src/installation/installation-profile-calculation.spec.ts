import {
  InstallationBillingUnit,
  InstallationRuleMetric,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import {
  InstallationPricingService,
  type InstallationPricingDimensions,
  type InstallationProfileRateAdjustment,
  type InstallationProfileSnapshot,
  type InstallationServiceForPricing,
} from './installation-pricing.service';

const dec = (value: string | number) => new Prisma.Decimal(value);
const adjustment = (
  overrides: Partial<InstallationProfileRateAdjustment> = {},
): InstallationProfileRateAdjustment => ({
  serviceId: 1, ruleId: null, type: 'PERCENT', value: '12.5', ...overrides,
});
const profile = (
  adjustments: InstallationProfileRateAdjustment[] = [],
): InstallationProfileSnapshot => ({
  id: 4, name: 'Retail', adjustmentPercent: new Decimal(80), minimumCharge: new Decimal(500),
  rateAdjustments: { schema: 1, adjustments },
});
const service = (
  overrides: Partial<InstallationServiceForPricing> = {},
): InstallationServiceForPricing => ({
  id: 1, name: 'Provider service', description: null, billingUnit: 'UNIT', ruleMetric: 'NONE',
  baseRate: dec('12.3456'), minimumCharge: dec(0), estimatedMinutes: dec(15),
  availableForRequest: true, availableForField: true, isActive: true, sortOrder: 0,
  createdAt: new Date(0), updatedAt: new Date(0), rules: [], ...overrides,
});
const rule = (
  id: number,
  overrides: Partial<InstallationServiceForPricing['rules'][number]> = {},
): InstallationServiceForPricing['rules'][number] => ({
  id, serviceId: 1, minValue: null, minInclusive: true, maxValue: null, maxInclusive: false,
  rate: dec('12.3456'), estimatedMinutes: null, isActive: true, sortOrder: id,
  createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
});

describe('Installation profile calculation across billing units', () => {
  const pricing = new InstallationPricingService({} as never);
  const dimensions: InstallationPricingDimensions = {
    widthIn: 24, heightIn: 36, panelCount: 3, lengthIn: 30, configName: 'Triangle Left',
  };
  const units: Array<{
    unit: InstallationBillingUnit; quantity: string; provider: string; percent: string; amount: string;
  }> = [
    { unit: 'UNIT', quantity: '1', provider: '24.69', percent: '27.78', amount: '25.56' },
    { unit: 'PANEL', quantity: '3', provider: '74.07', percent: '83.33', amount: '76.67' },
    { unit: 'SQFT', quantity: '3', provider: '74.07', percent: '83.33', amount: '76.67' },
    { unit: 'SQFT_RECTANGULAR', quantity: '6', provider: '148.15', percent: '166.67', amount: '153.33' },
    { unit: 'LINEAR_FOOT', quantity: '2.5', provider: '61.73', percent: '69.44', amount: '63.89' },
  ];

  it.each(units)('applies independent service and rule tariffs for $unit without changing provider data', test => {
    for (const selectedRule of [false, true]) {
      for (const type of ['PERCENT', 'AMOUNT'] as const) {
        const configured = service({
          billingUnit: test.unit, ruleMetric: selectedRule ? 'WIDTH' : 'NONE',
          rules: selectedRule ? [rule(11)] : [],
        });
        const selected = profile([
          // The deliberately large service increase must not leak into a selected rule.
          ...(selectedRule ? [adjustment({ value: '500' })] : []),
          adjustment({ ruleId: selectedRule ? 11 : null, type, value: type === 'PERCENT' ? '12.5' : '0.4321' }),
        ]);
        const before = JSON.stringify({ configured, selected });
        const calculate = () => pricing.calculateLine({ service: configured, profile: selected, dimensions, occurrences: 2, origin: 'AUTO' });
        const result = calculate();
        expect(result.ruleId).toBe(selectedRule ? 11 : null);
        expect(result.billableQuantity.toString()).toBe(test.quantity);
        expect(result.rate.toFixed(4)).toBe('12.3456');
        expect(result.saleRate.toFixed(4)).toBe(type === 'PERCENT' ? '13.8888' : '12.7777');
        expect(result.baseAmount.toFixed(2)).toBe(test.provider);
        expect(result.adjustedAmount.toFixed(2)).toBe(type === 'PERCENT' ? test.percent : test.amount);
        expect(result.rateAdjustmentSnapshot.source).toBe(selectedRule ? 'RULE' : 'SERVICE');
        expect(calculate().adjustedAmount.toFixed(2)).toBe(result.adjustedAmount.toFixed(2));
        expect(JSON.stringify({ configured, selected })).toBe(before);
      }
    }
  });

  it('rounds the adjusted rate to four decimals before multiplying, and only then rounds money', () => {
    const result = pricing.calculateLine({
      service: service({ billingUnit: 'PANEL', baseRate: dec('1.2345') }),
      profile: profile([adjustment({ value: '12.3456' })]),
      dimensions: { panelCount: 5000 }, occurrences: 2, origin: 'USER_SELECTED',
    });
    expect(result.saleRate.toFixed(4)).toBe('1.3869');
    expect(result.baseAmount.toFixed(2)).toBe('12345.00');
    expect(result.adjustedAmount.toFixed(2)).toBe('13869.00');
  });

  it('uses full fractional billing quantity before storing its four-decimal display value', () => {
    const result = pricing.calculateLine({
      service: service({ billingUnit: 'LINEAR_FOOT', baseRate: dec(12000) }),
      profile: profile([adjustment({ value: '10' })]), dimensions: { lengthIn: 1 }, origin: 'FIELD_ADDED',
    });
    expect(result.billableQuantity.toFixed(4)).toBe('0.0833');
    expect(result.baseAmount.toFixed(2)).toBe('1000.00');
    expect(result.adjustedAmount.toFixed(2)).toBe('1100.00');
  });

  it.each(['PERCENT', 'AMOUNT'] as const)('an explicit zero %s adjustment preserves base rate and amounts', type => {
    const result = pricing.calculateLine({ service: service(), profile: profile([adjustment({ type, value: '0' })]),
      dimensions: {}, occurrences: 3, origin: 'AUTO' });
    expect(result.saleRate.toFixed(4)).toBe('12.3456');
    expect(result.adjustedAmount.toFixed(2)).toBe(result.baseAmount.toFixed(2));
    expect(result.rateAdjustmentSnapshot).toMatchObject({ source: 'SERVICE', type, value: '0.0000' });
  });

  it('can add an amount to a zero provider rate without modifying that base', () => {
    const input = service({ baseRate: dec(0) });
    const result = pricing.calculateLine({ service: input, profile: profile([adjustment({ type: 'AMOUNT', value: '5.25' })]),
      dimensions: {}, occurrences: 2, origin: 'AUTO' });
    expect(result.baseAmount.toFixed(2)).toBe('0.00');
    expect(result.adjustedAmount.toFixed(2)).toBe('10.50');
    expect(input.baseRate.toFixed(4)).toBe('0.0000');
  });

  it.each([
    { metric: 'WIDTH', dimensions: { widthIn: 48 } },
    { metric: 'HEIGHT', dimensions: { heightIn: 48 } },
    { metric: 'AREA', dimensions: { areaSqFt: 48 } },
    { metric: 'PANEL_COUNT', dimensions: { panelCount: 48 } },
    { metric: 'LENGTH', dimensions: { lengthIn: 48 } },
  ] as Array<{ metric: InstallationRuleMetric; dimensions: InstallationPricingDimensions }>)
  ('selects the correct boundary rule for $metric and excludes every unrelated adjustment', test => {
    const input = service({ ruleMetric: test.metric, rules: [
      rule(11, { maxValue: dec(48), maxInclusive: false, rate: dec(100) }),
      rule(12, { minValue: dec(48), minInclusive: true, rate: dec(150) }),
      rule(13, { isActive: false, rate: dec(999) }),
    ] });
    const selected = profile([
      adjustment({ value: '50' }), adjustment({ ruleId: 11, value: '20' }),
      adjustment({ ruleId: 12, type: 'AMOUNT', value: '10' }),
      adjustment({ ruleId: 13, value: '90' }), adjustment({ serviceId: 99, ruleId: 99, value: '80' }),
    ]);
    const result = pricing.calculateLine({ service: input, profile: selected, dimensions: test.dimensions, origin: 'AUTO' });
    expect(result.ruleId).toBe(12); expect(result.rate.toString()).toBe('150');
    expect(result.adjustedAmount.toFixed(2)).toBe('160.00');
    selected.rateAdjustments!.adjustments = selected.rateAdjustments!.adjustments.filter(item => item.ruleId !== 12);
    const base = pricing.calculateLine({ service: input, profile: selected, dimensions: test.dimensions, origin: 'AUTO' });
    expect(base.adjustedAmount.toFixed(2)).toBe('150.00');
    expect(base.rateAdjustmentSnapshot.source).toBe('NONE');
  });
});

describe('Profile resolution produces independent immutable calculation inputs', () => {
  const row = (id: number, isActive = true) => ({
    id, name: `Profile ${id}`, isActive, adjustmentPercent: dec(0), minimumCharge: dec(id * 100),
    adjustments: [{ ...adjustment({ value: String(id) }), value: dec(id), legacyLineRounding: false }],
  });

  it.each([
    { userActive: true, roleActive: true, expected: 1 },
    { userActive: false, roleActive: true, expected: 2 },
    { userActive: false, roleActive: false, expected: 3 },
  ])('resolves active assignments in priority order: $expected', async test => {
    const db: any = {
      user: { findUnique: jest.fn(async () => ({ installationPriceProfile: row(1, test.userActive),
        role: { installationPriceProfile: row(2, test.roleActive) } })) },
      installationPriceProfile: { findFirst: jest.fn(async () => row(3)) },
    };
    const result = await new InstallationPricingService({} as never).resolveProfileForUser(7, db);
    expect(result.id).toBe(test.expected);
    expect(result.minimumCharge.toString()).toBe(String(test.expected * 100));
    expect(db.installationPriceProfile.findFirst).toHaveBeenCalledTimes(test.expected === 3 ? 1 : 0);
    if (test.expected === 3) expect(db.installationPriceProfile.findFirst).toHaveBeenCalledWith({
      where: { isDefault: true, isActive: true }, include: { adjustments: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  });

  it('later catalog edits cannot mutate a previously resolved profile snapshot', async () => {
    const catalog = row(1);
    const db: any = { user: { findUnique: jest.fn(async () => ({ installationPriceProfile: catalog,
      role: { installationPriceProfile: null } })) }, installationPriceProfile: { findFirst: jest.fn() } };
    const pricing = new InstallationPricingService(db);
    const frozen = await pricing.resolveProfileForUser(7);
    catalog.adjustments[0].value = dec(99); catalog.minimumCharge = dec(900); catalog.name = 'Changed';
    expect(frozen.name).toBe('Profile 1'); expect(frozen.minimumCharge.toString()).toBe('100');
    expect(frozen.rateAdjustments!.adjustments[0].value).toBe('1.0000');
    const next = await pricing.resolveProfileForUser(7);
    expect(next.rateAdjustments!.adjustments[0].value).toBe('99.0000');
    const first = pricing.calculateLine({ service: service({ baseRate: dec(100) }), profile: frozen, dimensions: {}, origin: 'AUTO' });
    const second = pricing.calculateLine({ service: service({ baseRate: dec(100) }), profile: next, dimensions: {}, origin: 'AUTO' });
    expect(first.adjustedAmount.toFixed(2)).toBe('101.00'); expect(second.adjustedAmount.toFixed(2)).toBe('199.00');
  });
});

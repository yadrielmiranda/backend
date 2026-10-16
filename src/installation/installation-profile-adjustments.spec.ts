import { ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationCatalogService } from './installation-catalog.service';
import {
  CreateInstallationPriceProfileDto,
  UpdateInstallationPriceProfileDto,
} from './dto/installation-profile.dto';
import {
  InstallationPricingService,
  type InstallationProfileSnapshot,
  type InstallationProfileRateAdjustment,
} from './installation-pricing.service';

const actor = { id: 1, role: { name: 'admin' } } as const;
const adjustment = (overrides: Partial<InstallationProfileRateAdjustment> = {}): InstallationProfileRateAdjustment => ({
  serviceId: 1, ruleId: null, type: 'PERCENT', value: '20', ...overrides,
});
const profile = (adjustments: InstallationProfileRateAdjustment[] = []): InstallationProfileSnapshot => ({
  id: 1, name: 'Dealer', adjustmentPercent: new Decimal(0), minimumCharge: new Decimal(500),
  rateAdjustments: { schema: 1, adjustments },
});
const service = (overrides: Record<string, unknown> = {}): any => ({
  id: 1, name: 'Installation', billingUnit: 'UNIT', ruleMetric: 'NONE', baseRate: new Prisma.Decimal(100),
  minimumCharge: new Prisma.Decimal(0), estimatedMinutes: new Prisma.Decimal(15), rules: [], ...overrides,
});
const rule = (id = 2, rate = 150): any => ({
  id, serviceId: 1, minValue: null, maxValue: null, rate: new Prisma.Decimal(rate),
  isActive: true, sortOrder: 0, estimatedMinutes: null,
});

describe('Independent installation profile tariffs', () => {
  const pricing = new InstallationPricingService({} as any);
  const calculate = (selected: InstallationProfileSnapshot, input = service(), dimensions = {}, occurrences = 1) =>
    pricing.calculateLine({ service: input, profile: selected, dimensions, occurrences, origin: 'AUTO' });

  it('uses base tariffs when the new profile has no adjustment, without its legacy percentage', () => {
    const selected = profile(); selected.adjustmentPercent = new Decimal(90);
    const line = calculate(selected);
    expect(line.rate.toString()).toBe('100');
    expect(line.saleRate.toString()).toBe('100');
    expect(line.baseAmount.toString()).toBe('100');
    expect(line.adjustedAmount.toString()).toBe('100');
    expect(line.rateAdjustmentSnapshot).toMatchObject({ source: 'NONE', type: null, value: '0.0000' });
  });

  it('adds a fixed amount to each billable unit before quantity and occurrences', () => {
    const line = calculate(profile([adjustment({ type: 'AMOUNT', value: '2.5' })]),
      service({ billingUnit: 'PANEL', baseRate: new Prisma.Decimal(20) }), { panelCount: 3 }, 2);
    expect(line.saleRate.toString()).toBe('22.5');
    expect(line.baseAmount.toString()).toBe('120');
    expect(line.adjustedAmount.toString()).toBe('135');
    expect(line.timeSnapshot.totalMinutes).toBe('90');
  });

  it('applies the service percentage to its base tariff for fractional units', () => {
    const line = calculate(profile([adjustment({ value: '25' })]),
      service({ billingUnit: 'SQFT', baseRate: new Prisma.Decimal(25) }), { areaSqFt: 8.5 }, 2);
    expect(line.saleRate.toString()).toBe('31.25');
    expect(line.baseAmount.toString()).toBe('425');
    expect(line.adjustedAmount.toString()).toBe('531.25');
  });

  it('uses only the selected rule adjustment without combining its service adjustment', () => {
    const line = calculate(profile([adjustment({ value: '99' }), adjustment({ ruleId: 2, value: '10' })]),
      service({ ruleMetric: 'WIDTH', rules: [rule()] }), { widthIn: 30 });
    expect(line.rate.toString()).toBe('150');
    expect(line.adjustedAmount.toString()).toBe('165');
    expect(line.rateAdjustmentSnapshot).toMatchObject({ source: 'RULE', providerRate: '150.0000', saleRate: '165.0000' });
  });

  it('never inherits the service adjustment when a selected rule has none', () => {
    const line = calculate(profile([adjustment({ value: '99' })]),
      service({ ruleMetric: 'WIDTH', rules: [rule()] }), { widthIn: 30 });
    expect(line.adjustedAmount.toString()).toBe('150');
    expect(line.rateAdjustmentSnapshot.source).toBe('NONE');
  });

  it('preserves legacy line rounding for historical quotes and migrated unchanged adjustments', () => {
    const old: InstallationProfileSnapshot = { ...profile(), adjustmentPercent: new Decimal(50) };
    delete old.rateAdjustments;
    const tariff = service({ baseRate: new Prisma.Decimal('0.025') });
    expect(calculate(old, tariff).adjustedAmount.toString()).toBe('0.05');
    expect(calculate(profile([adjustment({ value: '50', legacyLineRounding: true })]), tariff).adjustedAmount.toString()).toBe('0.05');
    expect(calculate(profile([adjustment({ value: '50' })]), tariff).adjustedAmount.toString()).toBe('0.04');
  });

  it('retains a migrated negative percentage without granting new negative adjustments', () => {
    expect(calculate(profile([adjustment({ value: '-10', legacyLineRounding: true })])).adjustedAmount.toString()).toBe('90');
    expect(() => calculate(profile([adjustment({ value: '-10' })]))).toThrow('invalid');
  });

  it('keeps an adjusted tariff larger than the provider tariff column when the line amount fits', () => {
    const selected: InstallationProfileSnapshot = { ...profile(), adjustmentPercent: new Decimal(100) };
    delete selected.rateAdjustments;
    const tariff = service({ baseRate: new Prisma.Decimal('99999999.9999') });
    for (const candidate of [selected, profile([adjustment({ value: '100' })])]) {
      const line = calculate(candidate, tariff);
      expect(line.saleRate.toFixed(4)).toBe('199999999.9998');
      expect(line.adjustedAmount.toFixed(2)).toBe('200000000.00');
    }
  });

  it('rejects percentages that cannot fit the historical line percentage field', () => {
    expect(() => calculate(profile([adjustment({ value: '1000000' })]), service({ baseRate: new Prisma.Decimal(0) }))).toThrow('invalid');
  });

  it('stores the chosen tariff and adjustment without changing provider service or rules', () => {
    const input = service({ ruleMetric: 'WIDTH', rules: [rule()] });
    const before = JSON.stringify(input);
    const line = calculate(profile([adjustment({ ruleId: 2, type: 'AMOUNT', value: '20' })]), input, { widthIn: 30 });
    expect(line.ruleSnapshot).toMatchObject({ rate: '150' });
    expect(line.baseAmount.toString()).toBe('150');
    expect(line.adjustedAmount.toString()).toBe('170');
    expect(JSON.stringify(input)).toBe(before);
  });
});

function catalogFixture() {
  let saved: any = null;
  let nextAdjustmentId = 1;
  const services = [
    service({ rules: [rule()] }),
    service({ id: 3, baseRate: new Prisma.Decimal(300), isActive: false,
      rules: [{ ...rule(4, 400), serviceId: 3, isActive: false }] }),
  ];
  const rows = (entries: any[]) => entries.map(entry => ({ ...entry, id: nextAdjustmentId++, profileId: 1 }));
  const db: any = {
    installationService: {
      findMany: jest.fn(async () => services),
      create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(),
    },
    installationServiceRule: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ installationPriceProfile: saved, role: { installationPriceProfile: null } })) },
    installationPriceProfile: {
      findFirst: jest.fn(async () => saved?.isDefault ? saved : null),
      findUnique: jest.fn(async () => saved),
      updateMany: jest.fn(async () => { if (saved) saved.isDefault = false; }),
      create: jest.fn(async ({ data }) => {
        saved = { ...data, id: 1, adjustments: rows(data.adjustments.create), _count: { users: 0, roles: 0, quotes: 0 } };
        return saved;
      }),
      update: jest.fn(async ({ data }) => {
        saved = { ...saved, ...data, adjustments: data.adjustments ? rows(data.adjustments.create) : saved.adjustments };
        return saved;
      }),
    },
  };
  db.$transaction = jest.fn(async (work: (tx: any) => Promise<unknown>) => work(db));
  const catalog = new InstallationCatalogService(db, { log: jest.fn() } as any);
  return { catalog, db, services, saved: () => saved };
}

describe('Installation profile adjustment catalog', () => {
  const create = (f: ReturnType<typeof catalogFixture>, adjustments: any[] = []) =>
    f.catalog.createProfile({ name: 'Dealer', minimumCharge: 500, adjustments }, actor);

  it('saves service and rule adjustments independently and never edits provider tariffs', async () => {
    const f = catalogFixture();
    const providerBefore = JSON.stringify(f.services);
    const saved = await create(f, [adjustment(), adjustment({ ruleId: 2, type: 'AMOUNT', value: '30' })]);
    expect(saved.adjustmentPercent.toString()).toBe('0');
    expect(saved.minimumCharge.toString()).toBe('500');
    expect(saved.adjustments.map(row => [row.targetKey, row.type, row.value.toString()])).toEqual([
      ['SERVICE:1', 'PERCENT', '20'], ['RULE:2', 'AMOUNT', '30'],
    ]);
    expect(f.db.installationService.findMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.services)).toBe(providerBefore);
    for (const model of [f.db.installationService, f.db.installationServiceRule]) {
      for (const operation of ['create', 'update', 'updateMany', 'deleteMany']) {
        expect(model[operation]).not.toHaveBeenCalled();
      }
    }
  });

  it('round-trips decimal DTO values through saved profile lookup and installation pricing', async () => {
    const f = catalogFixture();
    const providerBefore = JSON.stringify(f.services);
    const pipe = new ValidationPipe({ transform: true, whitelist: true,
      transformOptions: { enableImplicitConversion: true } });
    const dto = await pipe.transform({ name: 'Precise rates', minimumCharge: 500,
      adjustments: [
        { serviceId: '1', ruleId: null, type: 'PERCENT', value: '12.3456' },
        { serviceId: '1', ruleId: '2', type: 'AMOUNT', value: '7.8901' },
        { serviceId: '3', ruleId: '4', type: 'AMOUNT', value: '0.0001' },
      ] }, { type: 'body', metatype: CreateInstallationPriceProfileDto });
    await f.catalog.createProfile(dto, actor);
    const reloaded = await f.catalog.findProfile(1);
    expect(reloaded.adjustments.map(entry => [entry.serviceId, entry.ruleId, entry.value.toFixed(4)])).toEqual([
      [1, null, '12.3456'], [1, 2, '7.8901'], [3, 4, '0.0001'],
    ]);
    const pricing = new InstallationPricingService(f.db);
    const selected = await pricing.resolveProfileForUser(7);
    const baseLine = pricing.calculateLine({ service: f.services[0], profile: selected,
      dimensions: {}, occurrences: 1, origin: 'AUTO' });
    const ruleLine = pricing.calculateLine({ service: { ...f.services[0], ruleMetric: 'WIDTH' }, profile: selected,
      dimensions: { widthIn: 30 }, occurrences: 1, origin: 'AUTO' });
    expect(baseLine.saleRate.toFixed(4)).toBe('112.3456');
    expect(baseLine.adjustedAmount.toFixed(2)).toBe('112.35');
    expect(ruleLine.saleRate.toFixed(4)).toBe('157.8901');
    expect(ruleLine.adjustedAmount.toFixed(2)).toBe('157.89');
    expect(ruleLine.baseAmount.toFixed(2)).toBe('150.00');
    expect(JSON.stringify(f.services)).toBe(providerBefore);
  });

  it('replaces targets explicitly, preserves a zero override and returns removed targets to base pricing', async () => {
    const f = catalogFixture();
    await create(f, [adjustment(), adjustment({ ruleId: 2, type: 'AMOUNT', value: '30' }),
      adjustment({ serviceId: 3, ruleId: 4, value: '15' })]);
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const dto = await pipe.transform({ adjustments: [
      { serviceId: 3, ruleId: 4, type: 'PERCENT', value: 15 },
      { serviceId: 1, type: 'AMOUNT', value: 0 },
    ] }, { type: 'body', metatype: UpdateInstallationPriceProfileDto });
    await f.catalog.updateProfile(1, dto, actor);
    const reloaded = await f.catalog.findProfile(1);
    expect(reloaded.adjustments.map(entry => [entry.targetKey, entry.serviceId, entry.ruleId, entry.value.toString()])).toEqual([
      ['RULE:4', 3, 4, '15'], ['SERVICE:1', 1, null, '0'],
    ]);
    expect(reloaded.minimumCharge.toString()).toBe('500');
    const pricing = new InstallationPricingService(f.db);
    const selected = await pricing.resolveProfileForUser(7);
    expect(selected.rateAdjustments?.adjustments).toEqual([
      adjustment({ serviceId: 3, ruleId: 4, value: '15.0000' }),
      adjustment({ type: 'AMOUNT', value: '0.0000' }),
    ]);
    const ruleLine = pricing.calculateLine({ service: { ...f.services[0], ruleMetric: 'WIDTH' }, profile: selected,
      dimensions: { widthIn: 30 }, occurrences: 1, origin: 'AUTO' });
    expect(ruleLine.adjustedAmount.toString()).toBe('150');
    expect(ruleLine.rateAdjustmentSnapshot.source).toBe('NONE');
    await f.catalog.updateProfile(1, { adjustments: [] }, actor);
    expect((await pricing.resolveProfileForUser(7)).rateAdjustments).toEqual({ schema: 1, adjustments: [] });
    for (const model of [f.db.installationService, f.db.installationServiceRule]) {
      for (const operation of ['create', 'update', 'updateMany', 'deleteMany']) expect(model[operation]).not.toHaveBeenCalled();
    }
  });

  it.each([
    [adjustment({ ruleId: 4 })],
    [adjustment({ serviceId: 99 })],
    [adjustment(), adjustment({ ruleId: undefined })],
  ].map(entries => [entries]))('rejects an invalid replacement before changing defaults or persisted adjustments %j', async entries => {
    const f = catalogFixture();
    await create(f, [adjustment(), adjustment({ ruleId: 2, type: 'AMOUNT', value: '30' })]);
    const before = JSON.stringify(f.saved());
    f.db.installationPriceProfile.updateMany.mockClear();
    await expect(f.catalog.updateProfile(1, { isDefault: true,
      adjustments: entries.map(entry => ({ ...entry, value: Number(entry.value) })),
    }, actor)).rejects.toThrow();
    expect(f.db.installationPriceProfile.updateMany).not.toHaveBeenCalled();
    expect(f.db.installationPriceProfile.update).not.toHaveBeenCalled();
    expect(JSON.stringify(f.saved())).toBe(before);
  });

  it('creates an active default with base prices when no adjustments are supplied', async () => {
    const f = catalogFixture();
    const saved = await f.catalog.createProfile({ name: 'Base rates', minimumCharge: 0, isActive: false }, actor);
    expect(saved).toMatchObject({ isDefault: true, isActive: true, adjustments: [] });
    expect(saved.adjustmentPercent.toString()).toBe('0');
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(f.db.installationService.findMany).not.toHaveBeenCalled();
    expect(f.db.installationPriceProfile.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(f.db.installationPriceProfile.create.mock.invocationCallOrder[0]);
  });

  it('preserves configured targets when selecting the default and refuses to deactivate that default', async () => {
    const f = catalogFixture();
    await create(f, [adjustment({ ruleId: 2, type: 'AMOUNT', value: '30' })]);
    f.saved().isDefault = false;
    f.saved().isActive = false;
    const before = JSON.stringify(f.saved().adjustments);
    const saved = await f.catalog.updateProfile(1, { isDefault: true, isActive: false }, actor);
    expect(saved.isDefault).toBe(true);
    expect(saved.isActive).toBe(true);
    expect(JSON.stringify(saved.adjustments)).toBe(before);
    await expect(f.catalog.updateProfile(1, { isActive: false }, actor)).rejects.toThrow('cannot be inactive');
    await expect(f.catalog.updateProfile(1, { isDefault: false }, actor)).rejects.toThrow('another default');
    expect(JSON.stringify(f.saved().adjustments)).toBe(before);
  });

  it('does not let callers forge or transfer a migrated negative adjustment to another target', async () => {
    const f = catalogFixture();
    await expect(create(f, [adjustment({ value: '-10', legacyLineRounding: true })])).rejects.toThrow('nonnegative');
    await create(f, [adjustment({ ruleId: 2 })]);
    Object.assign(f.saved().adjustments[0], { value: new Prisma.Decimal(-10), legacyLineRounding: true });
    for (const candidate of [
      { serviceId: 1, ruleId: null, type: 'PERCENT', value: -10 },
      { serviceId: 3, ruleId: 4, type: 'PERCENT', value: -10 },
      { serviceId: 1, ruleId: 2, type: 'AMOUNT', value: -10 },
    ]) {
      await expect(f.catalog.updateProfile(1, { adjustments: [candidate as any] }, actor)).rejects.toThrow('nonnegative');
    }
    expect(f.saved().adjustments[0].targetKey).toBe('RULE:2');
    expect(f.saved().adjustments[0].value.toString()).toBe('-10');
  });

  it.each([
    [adjustment({ ruleId: 4 })],
    [adjustment({ serviceId: 9 })],
    [adjustment(), adjustment()],
    [adjustment({ value: '-1' })],
    [adjustment({ value: '100000000' })],
    [adjustment({ value: '1000000' })],
    [adjustment({ value: '0.00001' })],
  ].map(entries => [entries]))('rejects invalid or duplicate adjustments %j', async entries => {
    const f = catalogFixture();
    await expect(create(f, entries)).rejects.toThrow();
    expect(f.db.installationPriceProfile.create).not.toHaveBeenCalled();
  });

  it('preserves adjustments on a metadata edit and removes them only when explicitly replaced', async () => {
    const f = catalogFixture(); await create(f, [adjustment()]);
    expect((await f.catalog.updateProfile(1, { name: 'Renamed' }, actor)).adjustments).toHaveLength(1);
    expect((await f.catalog.updateProfile(1, { adjustments: [] }, actor)).adjustments).toHaveLength(0);
  });

  it('preserves migrated rounding and negative percentages only when their exact adjustment is retained', async () => {
    const f = catalogFixture(); await create(f, [adjustment()]);
    Object.assign(f.saved().adjustments[0], { value: new Prisma.Decimal(-10), legacyLineRounding: true });
    const saved = await f.catalog.updateProfile(1, { adjustments: [{ serviceId: 1, ruleId: null, type: 'PERCENT', value: -10 }] }, actor);
    expect(saved.adjustments[0].legacyLineRounding).toBe(true);
    await expect(f.catalog.updateProfile(1, { adjustments: [{ serviceId: 1, type: 'PERCENT', value: -20 }] }, actor)).rejects.toThrow('nonnegative');
    expect((await f.catalog.updateProfile(1, { adjustments: [{ serviceId: 1, type: 'PERCENT', value: 10 }] }, actor)).adjustments[0].legacyLineRounding).toBe(false);
  });

  it('rejects the removed global percentage through both DTO and direct service calls', async () => {
    const f = catalogFixture();
    const dto = { name: 'Old client', adjustmentPercent: 10, minimumCharge: 0 };
    await expect(f.catalog.createProfile(dto, actor)).rejects.toThrow('separate service and rule');
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    await expect(pipe.transform(dto, { type: 'body', metatype: CreateInstallationPriceProfileDto })).rejects.toThrow();
  });

  it.each([true, '', [], {}, 'NaN'])('rejects a nonnumeric profile adjustment %j', async value => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
    await expect(pipe.transform({ name: 'Dealer', minimumCharge: 0,
      adjustments: [{ serviceId: 1, type: 'AMOUNT', value }] },
    { type: 'body', metatype: CreateInstallationPriceProfileDto })).rejects.toThrow();
  });
});

describe('Installation profile resolution', () => {
  const row = (id: number) => ({ id, name: `Profile ${id}`, isActive: true,
    adjustmentPercent: new Prisma.Decimal(0), minimumCharge: new Prisma.Decimal(500),
    adjustments: [{ ...adjustment(), value: new Prisma.Decimal(20), legacyLineRounding: false }],
  });
  it.each(['user', 'role', 'default', 'base'])('resolves and freezes the %s profile tier', async tier => {
    const db: any = {
      user: { findUnique: jest.fn(async () => ({
        installationPriceProfile: tier === 'user' ? row(1) : null,
        role: { installationPriceProfile: tier === 'role' ? row(2) : null },
      })) },
      installationPriceProfile: { findFirst: jest.fn(async () => tier === 'default' ? row(3) : null) },
    };
    const result = await new InstallationPricingService(db).resolveProfileForUser(7);
    expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
    expect(result.id).toBe({ user: 1, role: 2, default: 3, base: null }[tier]);
    expect(result.rateAdjustments).toEqual({ schema: 1, adjustments: tier === 'base' ? [] : [{ ...adjustment(), value: '20.0000' }] });
  });
});

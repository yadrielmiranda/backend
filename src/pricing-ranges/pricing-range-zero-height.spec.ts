import { BillableHeightMode, Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { PricingRangesService } from './pricing-ranges.service';

const actor = { id: 1, role: { name: 'admin' } } as AuthUser;
const decimal = (value: string) => new Prisma.Decimal(value);
const input = {
  idSystem: 7, idConfig: 11, code: 'CIRCLE_WIDTH_BAND',
  minWidthIn: '19.125', maxWidthIn: '60', minHeightIn: '0', maxHeightIn: '0',
  minHeightInclusive: true, maxHeightInclusive: true,
  rules: [{ idCrystal: 4, costoA: '0', costoB: '1.25', costoC: '100' }],
};

function fixture(mode: BillableHeightMode = BillableHeightMode.FIXED, fixed: string | null = '0') {
  const target = {
    pricingComponents: [], billableHeightMode: mode,
    billableHeightFixedIn: fixed == null ? null : decimal(fixed),
  };
  let stored: any = {
    id: 20, idSystem: 7, idConfig: 11, code: input.code,
    minWidthIn: decimal('19.125'), maxWidthIn: decimal('60'),
    minWidthInclusive: true, maxWidthInclusive: true,
    minHeightIn: decimal('0'), maxHeightIn: decimal('0'),
    minHeightInclusive: true, maxHeightInclusive: true, sortOrder: 0, isActive: true,
  };
  let rules: any[] = [{ id: 30, rangeId: 20, idCrystal: 4,
    costoA: decimal('0'), costoB: decimal('1.25'), costoC: decimal('100') }];
  const snapshot = () => ({ ...stored, rules: rules.map(rule => ({ ...rule,
    crystal: { id: rule.idCrystal, glass: 'Fixture crystal', isActive: true },
  })) });
  const tx = {
    system: { findUnique: jest.fn(async () => ({ id: 7,
      brandProduct: { product: { kind: 'GLAZED_UNIT', pricingMode: 'AREA_PERIMETER' } },
    })) },
    sysConf: { findUnique: jest.fn(async () => target) },
    systemCrystal: { findUnique: jest.fn(async () => ({ crystal: { isActive: true } })) },
    pricingRule: { findFirst: jest.fn(async () => null) },
    pricingRange: {
      findUnique: jest.fn(async () => snapshot()),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => { stored = { id: 20, ...data }; return { ...stored }; }),
      update: jest.fn(async ({ data }: any) => { stored = { ...stored, ...data }; return { ...stored }; }),
    },
    pricingRangeRule: {
      deleteMany: jest.fn(async ({ where }: any) => {
        rules = rules.filter(rule => where.idCrystal.notIn.includes(rule.idCrystal));
        return { count: 0 };
      }),
      upsert: jest.fn(async ({ create, update }: any) => {
        const existing = rules.find(rule => rule.idCrystal === create.idCrystal);
        if (existing) Object.assign(existing, update);
        else rules.push({ id: 31, ...create });
      }),
    },
  };
  // Only transaction delegates exist, so validation cannot accidentally use a
  // separate catalog read before entering the create/update transaction.
  const prisma = { $transaction: jest.fn(async (work: any) => work(tx)) };
  const logs = { log: jest.fn(async () => undefined) };
  return { service: new PricingRangesService(prisma as any, logs as any), tx, target, logs };
}

describe('Pricing ranges for a zero fixed billable height', () => {
  it('creates a width band whose billable-height interval is exactly zero', async () => {
    const f = fixture();
    const saved = await f.service.create(input, actor);
    expect(saved.minHeightIn?.toString()).toBe('0');
    expect(saved.maxHeightIn?.toString()).toBe('0');
    expect(saved.minWidthIn?.toString()).toBe('19.125');
    expect(saved.rules[0].costoB.toString()).toBe('1.25');
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE' }));
  });

  it('lets an imported zero-height range update its price without resubmitting its bounds', async () => {
    const f = fixture();
    const saved = await f.service.update(20, { rules: [{ ...input.rules[0], costoC: '125.50' }] }, actor);
    expect(saved.minHeightIn?.toString()).toBe('0');
    expect(saved.maxHeightIn?.toString()).toBe('0');
    expect(saved.rules[0].costoC.toString()).toBe('125.5');
    expect(f.logs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE' }));
  });

  it.each(['minWidthIn', 'maxWidthIn'] as const)('still rejects zero %s for both creation and updates', async field => {
    const f = fixture();
    await expect(f.service.create({ ...input, [field]: '0' }, actor)).rejects.toThrow('width must be greater than zero');
    await expect(f.service.update(20, { [field]: '0' }, actor)).rejects.toThrow('width must be greater than zero');
    expect(f.tx.pricingRange.create).not.toHaveBeenCalled();
    expect(f.tx.pricingRange.update).not.toHaveBeenCalled();
  });

  it.each([
    [BillableHeightMode.ACTUAL_HEIGHT, null],
    [BillableHeightMode.WIDTH_PERCENTAGE, null],
    [BillableHeightMode.FIXED, '5'],
    [BillableHeightMode.FIXED, null],
  ] as const)('rejects zero-height creation and existing-range edits for %s/%s', async (mode, fixed) => {
    const f = fixture(mode, fixed);
    await expect(f.service.create(input, actor)).rejects.toThrow('height must be greater than zero');
    await expect(f.service.update(20, { sortOrder: 1 }, actor)).rejects.toThrow('height must be greater than zero');
    expect(f.tx.pricingRange.create).not.toHaveBeenCalled();
    expect(f.tx.pricingRange.update).not.toHaveBeenCalled();
    expect(f.logs.log).not.toHaveBeenCalled();
  });

  it('keeps zero-height interval inclusivity and negative-height validation', async () => {
    const f = fixture();
    await expect(f.service.create({ ...input, minHeightInclusive: false }, actor)).rejects.toThrow('height range is empty');
    await expect(f.service.update(20, { maxHeightInclusive: false }, actor)).rejects.toThrow('height range is empty');
    await expect(f.service.create({ ...input, minHeightIn: '-1' }, actor)).rejects.toThrow('height must be zero or greater');
  });

  it('continues to accept positive height bounds for ordinary configurations', async () => {
    const f = fixture(BillableHeightMode.ACTUAL_HEIGHT, null);
    const saved = await f.service.create({ ...input, minHeightIn: '12', maxHeightIn: '60' }, actor);
    expect(saved.minHeightIn?.toString()).toBe('12');
    expect(saved.maxHeightIn?.toString()).toBe('60');
  });
});

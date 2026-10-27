import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SystemsService } from './systems.service';
import { UpdateSystemFrameColorsDto } from './dto/update-system-frame-colors.dto';

const multiplier = '1.23456789012345678901';
const deduction = '123456789012345678.1234567890123456789';

function fixture() {
  const catalog = [{ id: 7, color: 'Custom finish' }, { id: 8, color: 'Other finish' }];
  let associations: any[] = [10, 20].map(idSystem => ({
    idSystem, idFrameColor: 7, sortOrder: 0, isDefault: true,
    modifierEnabled: false, basePriceMultiplier: new Prisma.Decimal(1), basePriceDeduction: new Prisma.Decimal(0),
  }));
  const tx = {
    systemFrameColor: {
      deleteMany: jest.fn(async ({ where }: any) => {
        associations = associations.filter(row => row.idSystem !== where.idSystem);
      }),
      createMany: jest.fn(async ({ data }: any) => { associations.push(...data); }),
    },
  };
  const db = {
    system: {
      findUnique: jest.fn(async ({ where }: any) => [10, 20].includes(where.id) ? {
        id: where.id, name: `Series ${where.id}`, idBrand: 1, idProduct: 2,
        brandProduct: { brand: { id: 1, name: 'Brand' }, product: { id: 2, name: 'Product' } },
        systemFrameColors: associations.filter(row => row.idSystem === where.id).map(row => ({
          ...row, frameColor: catalog.find(color => color.id === row.idFrameColor),
        })),
      } : null),
    },
    frameColor: {
      findMany: jest.fn(async (args: any) => args.where?.id?.in
        ? catalog.filter(color => args.where.id.in.includes(color.id)) : catalog),
    },
    $transaction: jest.fn(async (work: any) => work(tx)),
  };
  const service = new SystemsService(db as any);
  const update = (changes: Record<string, unknown> = {}, systemId = 10) => service.updateSystemFrameColors(systemId, {
    frameColors: [{ frameColorId: 7, sortOrder: 0, isDefault: true, ...changes }],
  });
  return { db, tx, service, update };
}

describe('Frame base modifiers configured per series and frame color', () => {
  it('returns neutral settings for existing neutral associations and initializes newly linked colors off', async () => {
    const f = fixture();
    expect((await f.service.getSystemFrameColorsForManage(10)).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: false, basePriceMultiplier: '1', basePriceDeduction: '0',
    });
    const result = await f.service.updateSystemFrameColors(10, {
      frameColors: [
        { frameColorId: 7, sortOrder: 0, isDefault: true },
        { frameColorId: 8, sortOrder: 1, isDefault: false },
      ],
    });
    expect(result.selectedFrameColors[1]).toEqual({
      idFrameColor: 8, sortOrder: 1, isDefault: false,
      modifierEnabled: false, basePriceMultiplier: '1', basePriceDeduction: '0',
    });
  });

  it('round-trips long decimal strings without numeric rounding', async () => {
    const f = fixture();
    const result = await f.update({ modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction });
    expect(result.selectedFrameColors[0]).toMatchObject({
      modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction,
    });
    expect(f.tx.systemFrameColor.createMany.mock.calls[0][0].data[0].basePriceMultiplier.toFixed()).toBe(multiplier);
    expect(f.tx.systemFrameColor.createMany.mock.calls[0][0].data[0].basePriceDeduction.toFixed()).toBe(deduction);
    expect((await f.service.getSystemFrameColorsForManage(10)).selectedFrameColors[0].basePriceMultiplier).toBe(multiplier);
  });

  it('disables and re-enables the modifier without erasing its saved coefficients', async () => {
    const f = fixture();
    await f.update({ modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction });
    expect((await f.update({ modifierEnabled: false })).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: false, basePriceMultiplier: multiplier, basePriceDeduction: deduction,
    });
    expect((await f.update({ modifierEnabled: true })).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction,
    });
  });

  it('preserves modifier settings during legacy ID-list and default/order updates', async () => {
    const f = fixture();
    await f.update({ modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction });
    const legacy = await f.service.updateSystemFrameColors(10, { frameColorIds: [8, 7] });
    expect(legacy.selectedFrameColors.find(row => row.idFrameColor === 7)).toEqual({
      idFrameColor: 7, sortOrder: 1, isDefault: true,
      modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction,
    });
    const reordered = await f.service.updateSystemFrameColors(10, { frameColors: [
      { frameColorId: 7, sortOrder: 4, isDefault: false },
      { frameColorId: 8, sortOrder: 2, isDefault: true },
    ] });
    expect(reordered.selectedFrameColors.find(row => row.idFrameColor === 7)).toEqual({
      idFrameColor: 7, sortOrder: 4, isDefault: false,
      modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction,
    });
  });

  it('keeps one series independent from another using the same frame color', async () => {
    const f = fixture();
    await f.update({ modifierEnabled: true, basePriceMultiplier: '2', basePriceDeduction: '3' });
    expect((await f.service.getSystemFrameColorsForManage(20)).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: false, basePriceMultiplier: '1', basePriceDeduction: '0',
    });
    await f.update({ modifierEnabled: true, basePriceMultiplier: '4', basePriceDeduction: '5' }, 20);
    expect((await f.service.getSystemFrameColorsForManage(10)).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: true, basePriceMultiplier: '2', basePriceDeduction: '3',
    });
  });

  it('accepts neutral numeric input and returns canonical strings', async () => {
    const f = fixture();
    expect((await f.update({ basePriceMultiplier: 1, basePriceDeduction: 0 })).selectedFrameColors[0]).toMatchObject({
      modifierEnabled: false, basePriceMultiplier: '1', basePriceDeduction: '0',
    });
  });

  it.each([
    { modifierEnabled: null }, { modifierEnabled: 'false' }, { modifierEnabled: 1 },
    { basePriceMultiplier: null }, { basePriceMultiplier: 0 }, { basePriceMultiplier: '0.0000' },
    { basePriceMultiplier: '-1' }, { basePriceMultiplier: '' }, { basePriceMultiplier: true },
    { basePriceMultiplier: 'NaN' }, { basePriceMultiplier: Infinity },
    { basePriceMultiplier: '1000000000000000000' }, { basePriceMultiplier: '1.123456789012345678901' },
    { basePriceDeduction: null }, { basePriceDeduction: '-1' }, { basePriceDeduction: '' },
    { basePriceDeduction: 'Infinity' }, { basePriceDeduction: NaN },
    { basePriceDeduction: '1000000000000000000' }, { basePriceDeduction: '0.123456789012345678901' },
  ])('rejects invalid modifier data before writing even when disabled: %j', async changes => {
    const f = fixture();
    await expect(f.update({ modifierEnabled: false, ...changes })).rejects.toThrow();
    expect(f.db.$transaction).not.toHaveBeenCalled();
    const dto = plainToInstance(UpdateSystemFrameColorsDto, {
      frameColors: [{ frameColorId: 7, sortOrder: 0, isDefault: true, modifierEnabled: false, ...changes }],
    }, { enableImplicitConversion: true });
    expect(await validate(dto, { whitelist: true })).not.toHaveLength(0);
  });

  it('accepts optional legacy fields and exact precision at the DTO boundary', async () => {
    for (const changes of [{}, { modifierEnabled: true, basePriceMultiplier: multiplier, basePriceDeduction: deduction },
      { modifierEnabled: false, basePriceMultiplier: 1, basePriceDeduction: 0 },
      { basePriceMultiplier: '0.00000000000000000001', basePriceDeduction: '999999999999999999.99999999999999999999' }]) {
      const dto = plainToInstance(UpdateSystemFrameColorsDto, {
        frameColors: [{ frameColorId: 7, sortOrder: 0, isDefault: true, ...changes }],
      }, { enableImplicitConversion: true });
      expect(await validate(dto, { whitelist: true })).toEqual([]);
    }
  });
});

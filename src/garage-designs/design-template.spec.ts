import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { garageDesignHasGlass, readGarageDesignTemplate, type GarageDesignTemplate } from './design-template';
import { CreateDesignPatternDto, UpdateDesignPatternDto } from './dto/design-catalog.dto';
import { GarageDesignsService } from './garage-designs.service';

function template(): GarageDesignTemplate {
  return { version: 1, columns: [0.2, 0.8], rows: [0.3, 0.7], cells: [['slat', 'glass'], ['glass', 'slat']] };
}

describe('Garage design templates', () => {
  it('derives glass presence from valid cell materials, independently of the pattern name', () => {
    expect(garageDesignHasGlass(template())).toBe(true);
    expect(garageDesignHasGlass({ version: 1, columns: [1], rows: [0.5, 0.5], cells: [['slat'], ['slat']] })).toBe(false);
    expect(garageDesignHasGlass({ version: 1, columns: [1], rows: [0.5, 0.5], cells: [['slat'], ['glass']] })).toBe(true);
  });

  it.each([undefined, null, {}, { version: 1, columns: [1], rows: [1], cells: [] },
    { version: 1, columns: [1], rows: [1], cells: [['unknown']] },
  ])('does not classify absent or invalid geometry as glass-free (%j)', value => {
    expect(garageDesignHasGlass(value)).toBeNull();
  });

  it('preserves row-major materials and relative dimensions without a design-name lookup', () => {
    expect(readGarageDesignTemplate(template())).toEqual(template());
  });

  it('returns an independent canonical grid', () => {
    const input = template();
    const result = readGarageDesignTemplate(input)!;
    input.columns[0] = 0.9;
    input.rows[0] = 0.9;
    input.cells[0][0] = 'glass';
    expect(result).toEqual(template());
  });

  it.each([undefined, null, 1, 'svg', [], {}, { ...template(), version: 2 }, { ...template(), version: '1' },
    { ...template(), svg: '<svg onload="alert(1)" />' },
    { ...template(), columns: [] }, { ...template(), rows: [] },
    { ...template(), columns: [0, 1] }, { ...template(), rows: [-0.1, 1.1] },
    { ...template(), columns: [Number.NaN, 1] }, { ...template(), rows: [Number.POSITIVE_INFINITY, 1] },
    { ...template(), columns: ['0.2', 0.8] }, { ...template(), columns: [0.2, 0.7] },
    { ...template(), rows: [0.3, 0.700002] }, { ...template(), columns: new Array(2) },
    { ...template(), cells: [] }, { ...template(), cells: [['slat', 'glass']] },
    { ...template(), cells: [['slat'], ['glass', 'slat']] },
    { ...template(), cells: [['slat', 'glass', 'slat'], ['glass', 'slat']] },
    { ...template(), cells: [['slat', 'wood'], ['glass', 'slat']] },
    { ...template(), cells: [['slat', '<svg />'], ['glass', 'slat']] },
    { ...template(), cells: [new Array(2), ['glass', 'slat']] },
  ])('rejects malformed or executable input %#', value => {
    expect(readGarageDesignTemplate(value)).toBeNull();
  });

  it('accepts the smallest and largest grids and rejects either axis above 12', () => {
    expect(readGarageDesignTemplate({ version: 1, columns: [1], rows: [1], cells: [['slat']] })).not.toBeNull();
    const weights = Array(12).fill(1 / 12);
    const cells = Array.from({ length: 12 }, () => Array(12).fill('glass'));
    expect(readGarageDesignTemplate({ version: 1, columns: weights, rows: weights, cells })).not.toBeNull();
    expect(readGarageDesignTemplate({ version: 1, columns: Array(13).fill(1 / 13), rows: [1], cells: [Array(13).fill('slat')] })).toBeNull();
    expect(readGarageDesignTemplate({ version: 1, columns: [1], rows: Array(13).fill(1 / 13), cells: Array.from({ length: 13 }, () => ['slat']) })).toBeNull();
  });

  it('uses the 1e-6 sum tolerance and rejects materially different totals', () => {
    for (const total of [1, 1 - 1e-6, 1 + 1e-6]) {
      expect(readGarageDesignTemplate({ version: 1, columns: [total], rows: [total], cells: [['glass']] })).not.toBeNull();
    }
    for (const total of [1 - 2e-6, 1 + 2e-6]) {
      expect(readGarageDesignTemplate({ version: 1, columns: [total], rows: [1], cells: [['glass']] })).toBeNull();
    }
  });

  it('accepts absent, null and valid templates through DTO validation but rejects invalid JSON', async () => {
    for (const value of [undefined, null, template()]) {
      const dto = plainToInstance(CreateDesignPatternDto, { name: 'Custom design', template: value });
      expect(await validate(dto)).toEqual([]);
    }
    for (const value of ['<svg />', {}, { ...template(), cells: [['slat']] }]) {
      const dto = plainToInstance(UpdateDesignPatternDto, { template: value });
      expect((await validate(dto)).some(error => error.property === 'template')).toBe(true);
    }
  });
});

describe('Garage design template persistence', () => {
  function fixture() {
    const tx = { system: { findFirst: jest.fn(async () => null) }, designPattern: {
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    } };
    const prisma = { ...tx, $transaction: jest.fn(async (action: any) => action(tx)) };
    return { tx, service: new GarageDesignsService(prisma as any) };
  }

  it('saves a template with a design and preserves the optional image fallback', async () => {
    const f = fixture();
    expect(await f.service.createPattern({ name: 'Custom design', imageUrl: '/images/design.png', template: template() }))
      .toEqual({ id: 1, name: 'Custom design', imageUrl: '/images/design.png', template: template() });
  });

  it('distinguishes omission from an explicit template removal', async () => {
    const f = fixture();
    await f.service.updatePattern(1, { name: 'Renamed' });
    expect(f.tx.designPattern.update).toHaveBeenLastCalledWith({ where: { id: 1 }, data: { name: 'Renamed' } });
    await f.service.updatePattern(1, { template: null });
    expect(f.tx.designPattern.update).toHaveBeenLastCalledWith({ where: { id: 1 }, data: { template: Prisma.DbNull } });
  });

  it('rejects malformed templates before any catalog write, including direct service callers', async () => {
    const f = fixture();
    await expect(f.service.createPattern({ name: 'Bad', template: { ...template(), columns: [1] } }))
      .rejects.toThrow('Invalid design template');
    await expect(f.service.updatePattern(1, { template: '<svg />' as any })).rejects.toThrow('Invalid design template');
    expect(f.tx.designPattern.create).not.toHaveBeenCalled();
    expect(f.tx.designPattern.update).not.toHaveBeenCalled();
  });
});

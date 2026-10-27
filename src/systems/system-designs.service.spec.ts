import { SystemDesignsService } from './system-designs.service';
import { SystemsService } from './systems.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSystemDesignsDto } from './dto/system-designs.dto';
import { Prisma } from '@prisma/client';

function fixture() {
  const patterns = [1, 2].map((id) => ({
    id,
    name: `Design ${id}`,
    isActive: true,
  }));
  const colors = [3, 4].map((id) => ({
    id,
    name: `Color ${id}`,
    isActive: true,
  }));
  const system = {
    id: 10,
    name: 'Custom series',
    allowDesign: false,
    garageMaxSectionHeightIn: 24,
    defaultDesignId: null as number | null,
    defaultDesignColorId: null as number | null,
    brandProduct: {
      product: { id: 5, name: 'Garage', diagramFamily: 'GARAGE_DOOR' },
    },
    designOptions: [] as any[],
    designColorModifiers: [] as any[],
  };
  const find = (rows: any[]) =>
    jest.fn(async (args: any = {}) =>
      args.where?.id?.in
        ? rows.filter((row) => args.where.id.in.includes(row.id))
        : rows,
    );
  const tx = {
    system: {
      findUnique: jest.fn(async () => system),
      update: jest.fn(async ({ data }: any) => Object.assign(system, data)),
    },
    designPattern: { findMany: find(patterns) },
    designColor: { findMany: find(colors) },
    systemDesignOption: {
      deleteMany: jest.fn(async () => {
        system.designOptions = [];
      }),
      createMany: jest.fn(async ({ data }: any) => {
        system.designOptions = data.map((row: any) => ({
          ...row,
          design: patterns.find((pattern) => pattern.id === row.idDesign),
          color: colors.find((color) => color.id === row.idDesignColor),
        }));
      }),
    },
    systemDesignColorModifier: {
      upsert: jest.fn(async ({ create, update }: any) => {
        const existing = system.designColorModifiers.find(
          (row) => row.idDesignColor === create.idDesignColor,
        );
        const values = { ...(existing ?? create), ...update };
        const next = {
          ...values,
          basePriceMultiplier: new Prisma.Decimal(values.basePriceMultiplier),
          basePriceDeduction: new Prisma.Decimal(values.basePriceDeduction),
        };
        if (existing) Object.assign(existing, next);
        else system.designColorModifiers.push(next);
        return next;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) {
          if (
            !system.designColorModifiers.some(
              (existing) => existing.idDesignColor === row.idDesignColor,
            )
          ) {
            system.designColorModifiers.push({
              ...row,
              modifierEnabled: false,
              basePriceMultiplier: new Prisma.Decimal(1),
              basePriceDeduction: new Prisma.Decimal(0),
            });
          }
        }
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (action: any) => action(tx)),
  };
  const service = new SystemDesignsService(prisma as any);
  const data = {
    allowDesign: true,
    defaultDesignId: 1,
    defaultDesignColorId: 3,
    designs: [
      { designId: 1, colorIds: [3, 4], sortOrder: 0 },
      { designId: 2, colorIds: [4], sortOrder: 1 },
    ],
  };
  return { patterns, colors, system, tx, prisma, service, data };
}

describe('Garage design availability by series', () => {
  const modifier = (designColorId = 4) => ({
    designColorId,
    modifierEnabled: true,
    basePriceMultiplier: '1.050000629572269',
    basePriceDeduction: '105.00160112819593',
  });

  it('stores one modifier per series and color even when the color is used by multiple patterns', async () => {
    const f = fixture();
    const result = await f.service.update(10, {
      ...f.data,
      colorModifiers: [modifier()],
    });
    expect(result.colorModifiers).toEqual(
      expect.arrayContaining([
        modifier(),
        {
          designColorId: 3,
          modifierEnabled: false,
          basePriceMultiplier: '1',
          basePriceDeduction: '0',
        },
      ]),
    );
    expect(result.colorModifiers).toHaveLength(2);
    expect(f.tx.systemDesignColorModifier.upsert).toHaveBeenCalledWith({
      where: { idSystem_idDesignColor: { idSystem: 10, idDesignColor: 4 } },
      create: {
        idSystem: 10,
        idDesignColor: 4,
        modifierEnabled: true,
        basePriceMultiplier: modifier().basePriceMultiplier,
        basePriceDeduction: modifier().basePriceDeduction,
      },
      update: {
        modifierEnabled: true,
        basePriceMultiplier: modifier().basePriceMultiplier,
        basePriceDeduction: modifier().basePriceDeduction,
      },
    });
    expect(f.system.designColorModifiers).toHaveLength(2);
  });

  it('preserves exact coefficients when disabling, omitting or temporarily removing the color from all designs', async () => {
    const f = fixture();
    await f.service.update(10, { ...f.data, colorModifiers: [modifier()] });
    await f.service.update(10, {
      ...f.data,
      colorModifiers: [{ ...modifier(), modifierEnabled: false }],
    });
    const removed = await f.service.update(10, {
      allowDesign: false,
      designs: [],
      colorModifiers: [],
    });
    expect(removed.colorModifiers).toContainEqual({
      ...modifier(),
      modifierEnabled: false,
    });
    const restored = await f.service.update(10, f.data);
    expect(restored.colorModifiers).toContainEqual({
      ...modifier(),
      modifierEnabled: false,
    });
    expect(f.tx.systemDesignColorModifier.upsert).toHaveBeenCalledTimes(2);
  });

  it('initializes new series/colors with a disabled neutral modifier', async () => {
    const f = fixture();
    const result = await f.service.update(10, f.data);
    expect(result.colorModifiers).toEqual(
      [3, 4].map((designColorId) => ({
        designColorId,
        modifierEnabled: false,
        basePriceMultiplier: '1',
        basePriceDeduction: '0',
      })),
    );
    expect(f.tx.systemDesignColorModifier.createMany).toHaveBeenCalledWith({
      data: [
        { idSystem: 10, idDesignColor: 3 },
        { idSystem: 10, idDesignColor: 4 },
      ],
      skipDuplicates: true,
    });
  });

  it('reports neutral settings for a selected color whose stored modifier has not been created yet', async () => {
    const f = fixture();
    f.system.designOptions.push({
      idSystem: 10,
      idDesign: 1,
      idDesignColor: 3,
      sortOrder: 0,
    });
    expect((await f.service.manage(10)).colorModifiers).toEqual([
      {
        designColorId: 3,
        modifierEnabled: false,
        basePriceMultiplier: '1',
        basePriceDeduction: '0',
      },
    ]);
  });

  it('rejects unknown modifier colors before any write even if the allowed designs are valid', async () => {
    const f = fixture();
    await expect(
      f.service.update(10, { ...f.data, colorModifiers: [modifier(999)] }),
    ).rejects.toThrow('do not exist');
    expect(f.tx.systemDesignColorModifier.upsert).not.toHaveBeenCalled();
    expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    null,
    'invalid',
    [null],
    [modifier(), modifier()],
    [{ ...modifier(), designColorId: 0 }],
    [{ ...modifier(), modifierEnabled: null }],
    [{ ...modifier(), modifierEnabled: 'false' }],
    [{ ...modifier(), basePriceMultiplier: undefined }],
    [{ ...modifier(), basePriceMultiplier: null }],
    [{ ...modifier(), basePriceMultiplier: '0.000' }],
    [{ ...modifier(), basePriceMultiplier: '-1' }],
    [{ ...modifier(), basePriceMultiplier: '1e2' }],
    [{ ...modifier(), basePriceMultiplier: '1234567890123456789' }],
    [{ ...modifier(), basePriceMultiplier: '1.123456789012345678901' }],
    [{ ...modifier(), basePriceDeduction: '-0.01' }],
    [{ ...modifier(), basePriceDeduction: null }],
    [{ ...modifier(), basePriceDeduction: Infinity }],
  ])(
    'rejects malformed design color modifiers in the DTO and service: %j',
    async (colorModifiers) => {
      const f = fixture();
      const input = { ...f.data, colorModifiers };
      const errors = await validate(
        plainToInstance(UpdateSystemDesignsDto, input),
      );
      expect(errors.some((error) => error.property === 'colorModifiers')).toBe(
        true,
      );
      await expect(f.service.update(10, input as any)).rejects.toThrow();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('keeps full decimal precision through DTO transformation and storage', async () => {
    const f = fixture();
    const value = {
      ...modifier(),
      basePriceMultiplier: '1.25000000000000040001',
      basePriceDeduction: '874.99500000000160000001',
    };
    const input = plainToInstance(UpdateSystemDesignsDto, {
      ...f.data,
      colorModifiers: [value],
    });
    expect(await validate(input)).toEqual([]);
    expect(input.colorModifiers?.[0]).toEqual(value);
    expect((await f.service.update(10, input)).colorModifiers).toContainEqual(
      value,
    );
  });

  it('does not permit modifier-only configuration on a non-garage product', async () => {
    const f = fixture();
    f.system.brandProduct.product.diagramFamily = 'SINGLE_HUNG';
    await expect(
      f.service.update(10, {
        allowDesign: false,
        designs: [],
        colorModifiers: [modifier()],
      }),
    ).rejects.toThrow('Garage Door');
    expect(f.tx.systemDesignColorModifier.upsert).not.toHaveBeenCalled();
  });

  it('exposes the configured section height and saves it while designs are disabled', async () => {
    const f = fixture();
    expect((await f.service.manage(10)).garageMaxSectionHeightIn).toBe(24);
    const result = await f.service.update(10, {
      allowDesign: false,
      designs: [],
      garageMaxSectionHeightIn: 22.5,
    });
    expect(result).toMatchObject({
      allowDesign: false,
      garageMaxSectionHeightIn: 22.5,
      designs: [],
    });
    expect(f.system.garageMaxSectionHeightIn).toBe(22.5);
    expect(f.tx.system.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: {
        allowDesign: false,
        defaultDesignId: null,
        defaultDesignColorId: null,
        garageMaxSectionHeightIn: 22.5,
      },
    });
  });

  it('preserves a custom section height when an older editor omits it', async () => {
    const f = fixture();
    f.system.garageMaxSectionHeightIn = 20;
    expect((await f.service.update(10, f.data)).garageMaxSectionHeightIn).toBe(
      20,
    );
  });

  it.each([null, 0, -1, 0.99, 240.01, Infinity, NaN, '24', 24.001])(
    'rejects invalid section height before writing: %p',
    async (height) => {
      const f = fixture();
      await expect(
        f.service.update(10, {
          allowDesign: false,
          designs: [],
          garageMaxSectionHeightIn: height,
        } as any),
      ).rejects.toThrow('Maximum section height');
      expect(f.tx.system.update).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      const errors = await validate(
        plainToInstance(UpdateSystemDesignsDto, {
          allowDesign: false,
          designs: [],
          garageMaxSectionHeightIn: height,
        }),
      );
      expect(
        errors.some((error) => error.property === 'garageMaxSectionHeightIn'),
      ).toBe(true);
    },
  );

  it.each([1, 24, 24.01, 240])(
    'accepts valid section height %p in the request DTO',
    async (height) => {
      const errors = await validate(
        plainToInstance(UpdateSystemDesignsDto, {
          allowDesign: false,
          designs: [],
          garageMaxSectionHeightIn: height,
        }),
      );
      expect(errors).toEqual([]);
    },
  );

  it('does not apply garage section settings to a different product family', async () => {
    const f = fixture();
    f.system.brandProduct.product.diagramFamily = 'SINGLE_HUNG';
    await expect(
      f.service.update(10, {
        allowDesign: false,
        designs: [],
        garageMaxSectionHeightIn: 24,
      }),
    ).rejects.toThrow('Garage Door');
    expect(f.tx.system.update).not.toHaveBeenCalled();
  });

  it('prevents moving an enabled series to a non-garage product through the general editor', async () => {
    const prisma = {
      system: {
        findUnique: jest.fn(async () => ({
          id: 10,
          idBrand: 1,
          idProduct: 5,
          allowDesign: true,
        })),
      },
      brandProduct: {
        findUnique: jest.fn(async () => ({
          product: { kind: 'GLAZED_UNIT', diagramFamily: 'SINGLE_HUNG' },
          brand: {},
        })),
      },
      $transaction: jest.fn(),
    };
    await expect(
      new SystemsService(prisma as any).updateSystem({
        where: { id: 10 },
        data: { idProduct: 6 },
      }),
    ).rejects.toThrow('Disable Design');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('saves explicit pairs and an atomic default without depending on the series name', async () => {
    const f = fixture();
    const result = await f.service.update(10, f.data);
    expect(result.allowDesign).toBe(true);
    expect(result.defaultDesignId).toBe(1);
    expect(result.defaultDesignColorId).toBe(3);
    expect(result.designs).toEqual(f.data.designs);
    expect(f.tx.systemDesignOption.createMany).toHaveBeenCalledWith({
      data: [
        { idSystem: 10, idDesign: 1, idDesignColor: 3, sortOrder: 0 },
        { idSystem: 10, idDesign: 1, idDesignColor: 4, sortOrder: 0 },
        { idSystem: 10, idDesign: 2, idDesignColor: 4, sortOrder: 1 },
      ],
    });
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it.each([
    { defaultDesignId: null, defaultDesignColorId: null },
    { defaultDesignColorId: null },
    { defaultDesignId: 2, defaultDesignColorId: 3 },
    { designs: [{ designId: 1, colorIds: [], sortOrder: 0 }] },
    { designs: [{ designId: 1, colorIds: [3, 3], sortOrder: 0 }] },
    {
      designs: [
        { designId: 1, colorIds: [3], sortOrder: 0 },
        { designId: 1, colorIds: [4], sortOrder: 1 },
      ],
    },
    { designs: [{ designId: 1, colorIds: [3], sortOrder: -1 }] },
  ])(
    'rejects invalid combinations/defaults before writing: %j',
    async (patch) => {
      const f = fixture();
      await expect(
        f.service.update(10, { ...f.data, ...patch }),
      ).rejects.toThrow();
      expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
      expect(f.tx.system.update).not.toHaveBeenCalled();
    },
  );

  it('rejects non-garage products even when the series name is 875', async () => {
    const f = fixture();
    f.system.name = '875';
    f.system.brandProduct.product.diagramFamily = 'SINGLE_HUNG';
    await expect(f.service.update(10, f.data)).rejects.toThrow('Garage Door');
    expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects nonexistent catalog IDs without replacing existing permissions', async () => {
    const f = fixture();
    f.data.designs[1].colorIds = [999];
    await expect(f.service.update(10, f.data)).rejects.toThrow('do not exist');
    expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects newly selected inactive designs and colors', async () => {
    for (const which of ['patterns', 'colors'] as const) {
      const f = fixture();
      f[which][1].isActive = false;
      await expect(f.service.update(10, f.data)).rejects.toThrow(
        'New combinations',
      );
      expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
    }
  });

  it('retains existing inactive combinations for history but cannot default to one while enabled', async () => {
    const f = fixture();
    await f.service.update(10, f.data);
    f.patterns[1].isActive = false;
    expect((await f.service.update(10, f.data)).designs).toEqual(
      f.data.designs,
    );
    await expect(
      f.service.update(10, {
        ...f.data,
        defaultDesignId: 2,
        defaultDesignColorId: 4,
      }),
    ).rejects.toThrow('must both be active');
    const managed = await f.service.manage(10);
    expect(
      managed.designCatalog.find((design) => design.id === 2)?.isActive,
    ).toBe(false);
  });

  it('can disable a series and clear defaults while preserving its selected combinations', async () => {
    const f = fixture();
    await f.service.update(10, f.data);
    const result = await f.service.update(10, {
      ...f.data,
      allowDesign: false,
      defaultDesignId: null,
      defaultDesignColorId: null,
    });
    expect(result.allowDesign).toBe(false);
    expect(result.defaultDesignId).toBeNull();
    expect(result.designs).toEqual(f.data.designs);
  });

  it('reports missing systems before changing associations', async () => {
    const f = fixture();
    f.tx.system.findUnique.mockResolvedValueOnce(null as any);
    await expect(f.service.update(10, f.data)).rejects.toThrow(
      'System not found',
    );
    expect(f.tx.systemDesignOption.deleteMany).not.toHaveBeenCalled();
  });
});

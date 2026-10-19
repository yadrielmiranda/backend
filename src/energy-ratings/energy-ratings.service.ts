import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  CreateEnergyRatingDto,
  FindEnergyRatingsDto,
  UpdateEnergyRatingDto,
} from './dto/energy-rating.dto';
import { energyActiveKey } from './energy-rating-lookup';

const ratingInclude = {
  systemCrystal: {
    include: {
      crystal: true,
      system: {
        include: { brandProduct: { include: { brand: true, product: true } } },
      },
    },
  },
  config: true,
  tint: true,
  coating: true,
  privacy: true,
} satisfies Prisma.EnergyRatingInclude;

function serializeRating(
  row: Prisma.EnergyRatingGetPayload<{ include: typeof ratingInclude }>,
) {
  const {
    systemCrystal,
    config,
    tint,
    coating,
    privacy,
    activeKey,
    ...fields
  } = row;
  const { system, crystal } = systemCrystal;
  return {
    ...fields,
    system: {
      id: system.id,
      name: system.name,
      idBrand: system.idBrand,
      idProduct: system.idProduct,
      brand: { id: system.idBrand, name: system.brandProduct.brand.name },
      product: { id: system.idProduct, name: system.brandProduct.product.name },
    },
    crystal: { id: crystal.id, name: crystal.glass },
    config: config ? { id: config.id, name: config.conf } : null,
    tint: { id: tint.id, name: tint.color },
    coating: { id: coating.id, name: coating.name },
    privacy: { id: privacy.id, name: privacy.name },
  };
}

/** Also exported for importing reviewed records without a separate validation policy. */
export function validateEnergyValues(values: {
  uFactor?: unknown;
  shgc?: unknown;
  vlt?: unknown;
}) {
  const fields = ['uFactor', 'shgc', 'vlt'] as const;
  const present = fields.filter(
    (key) => values[key] !== null && values[key] !== undefined,
  );
  if (present.length !== 0 && present.length !== 3) {
    throw new BadRequestException(
      'U-factor, SHGC and VLT must all be supplied, or all left empty.',
    );
  }
  const parsed: Record<(typeof fields)[number], Prisma.Decimal | null> = {
    uFactor: null,
    shgc: null,
    vlt: null,
  };
  for (const key of present) {
    const value = values[key];
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      !(value instanceof Prisma.Decimal)
    ) {
      throw new BadRequestException(`${key} must be a decimal number.`);
    }
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
      throw new BadRequestException(`${key} must be a decimal number.`);
    }
    let decimal: Prisma.Decimal;
    try {
      decimal = new Prisma.Decimal(
        typeof value === 'string' ? value.trim() : value,
      );
    } catch {
      throw new BadRequestException(`${key} must be a decimal number.`);
    }
    if (
      !decimal.isFinite() ||
      decimal.isNegative() ||
      (key === 'uFactor' ? decimal.lte(0) || decimal.gte(10000) : decimal.gt(1))
    ) {
      throw new BadRequestException(
        key === 'uFactor'
          ? 'U-factor must be greater than zero and less than 10000.'
          : `${key.toUpperCase()} must be between zero and one.`,
      );
    }
    // Check what the decimal column will actually store, including tiny positive U-factors.
    parsed[key] = decimal.toDecimalPlaces(6);
    if (key === 'uFactor' && (parsed[key].lte(0) || parsed[key].gte(10000))) {
      throw new BadRequestException(
        'U-factor is outside the supported decimal precision.',
      );
    }
  }
  return parsed;
}

@Injectable()
export class EnergyRatingsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: FindEnergyRatingsDto) {
    const rows = await this.prisma.energyRating.findMany({
      where: query,
      include: ratingInclude,
      orderBy: [{ idSystem: 'asc' }, { idCrystal: 'asc' }, { id: 'asc' }],
    });
    return rows.map(serializeRating);
  }

  async findOne(id: number) {
    const row = await this.prisma.energyRating.findUnique({
      where: { id },
      include: ratingInclude,
    });
    if (!row) throw new NotFoundException('Energy rating not found.');
    return serializeRating(row);
  }

  async catalogOptions() {
    const systems = await this.prisma.system.findMany({
      where: {
        isActive: true,
        brandProduct: {
          brand: { isActive: true },
          product: { isActive: true, kind: 'GLAZED_UNIT' },
        },
      },
      include: {
        brandProduct: {
          include: {
            product: true,
            brand: {
              include: {
                brandTints: {
                  where: { tint: { isActive: true } },
                  include: { tint: true },
                  orderBy: { sortOrder: 'asc' },
                },
                brandCoatings: {
                  where: { coating: { isActive: true } },
                  include: { coating: true },
                  orderBy: { sortOrder: 'asc' },
                },
                brandPrivacies: {
                  where: { privacy: { isActive: true } },
                  include: { privacy: true },
                  orderBy: { sortOrder: 'asc' },
                },
              },
            },
          },
        },
        systemCrystals: {
          where: { crystal: { isActive: true } },
          include: { crystal: true },
          orderBy: { sortOrder: 'asc' },
        },
        sysconfs: {
          where: { config: { isActive: true }, isSelectableInEstimate: true },
          include: { config: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: [
        { idBrand: 'asc' },
        { idProduct: 'asc' },
        { sortOrder: 'asc' },
        { id: 'asc' },
      ],
    });
    return {
      systems: systems.map((system) => {
        const { brand, product } = system.brandProduct;
        return {
          id: system.id,
          name: system.name,
          idBrand: system.idBrand,
          idProduct: system.idProduct,
          brand: { id: brand.id, name: brand.name },
          product: { id: product.id, name: product.name },
          crystals: system.systemCrystals.map(({ crystal }) => ({
            id: crystal.id,
            name: crystal.glass,
          })),
          configs: system.sysconfs.map(({ config }) => ({
            id: config.id,
            name: config.conf,
          })),
          tints: brand.brandTints.map(({ tint }) => ({
            id: tint.id,
            name: tint.color,
          })),
          coatings: brand.brandCoatings.map(({ coating }) => ({
            id: coating.id,
            name: coating.name,
          })),
          privacies: brand.brandPrivacies.map(({ privacy }) => ({
            id: privacy.id,
            name: privacy.name,
          })),
        };
      }),
    };
  }

  private async prepare(
    db: Prisma.TransactionClient,
    dto: CreateEnergyRatingDto,
  ) {
    for (const key of [
      'idSystem',
      'idCrystal',
      'idTint',
      'idCoating',
      'idPrivacy',
    ] as const) {
      if (!Number.isInteger(dto[key]) || dto[key] < 1)
        throw new BadRequestException(`${key} is required.`);
    }
    const idConfig = dto.idConfig ?? null;
    const appliesToAllConfigs = dto.appliesToAllConfigs ?? false;
    if (idConfig !== null && (!Number.isInteger(idConfig) || idConfig < 1)) {
      throw new BadRequestException('Configuration must be a valid ID.');
    }
    if ((idConfig === null) !== appliesToAllConfigs) {
      throw new BadRequestException(
        'Choose one configuration, or explicitly confirm that these values apply to all configurations.',
      );
    }
    const values = validateEnergyValues(dto);
    const systemCrystal = await db.systemCrystal.findUnique({
      where: {
        idSystem_idCrystal: {
          idSystem: dto.idSystem,
          idCrystal: dto.idCrystal,
        },
      },
      include: {
        system: { include: { brandProduct: { include: { product: true } } } },
      },
    });
    if (
      !systemCrystal ||
      systemCrystal.system.brandProduct.product.kind !== 'GLAZED_UNIT'
    ) {
      throw new BadRequestException(
        'The glass must belong to the selected glazed series.',
      );
    }
    const idBrand = systemCrystal.system.idBrand;
    const [tint, coating, privacy, config] = await Promise.all([
      db.brandTint.findUnique({
        where: { idBrand_idTint: { idBrand, idTint: dto.idTint } },
      }),
      db.brandCoating.findUnique({
        where: { idBrand_idCoating: { idBrand, idCoating: dto.idCoating } },
      }),
      db.brandPrivacy.findUnique({
        where: { idBrand_idPrivacy: { idBrand, idPrivacy: dto.idPrivacy } },
      }),
      idConfig === null
        ? Promise.resolve(true)
        : db.sysConf.findUnique({
            where: { idSystem_idConfig: { idSystem: dto.idSystem, idConfig } },
          }),
    ]);
    if (!tint || !coating || !privacy) {
      throw new BadRequestException(
        'Tint, coating and privacy must be associated with the series brand.',
      );
    }
    if (!config)
      throw new BadRequestException(
        'The configuration must belong to the selected series.',
      );
    const isActive = dto.isActive ?? true;
    return {
      idSystem: dto.idSystem,
      idCrystal: dto.idCrystal,
      idTint: dto.idTint,
      idCoating: dto.idCoating,
      idPrivacy: dto.idPrivacy,
      idConfig,
      appliesToAllConfigs,
      ...values,
      isActive,
      activeKey: isActive ? energyActiveKey({ ...dto, idConfig }) : null,
    };
  }

  private conflict(error: unknown): never {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new ConflictException(
        'An active energy rating already exists for this exact combination. Edit it or deactivate it before adding another.',
      );
    }
    throw error;
  }

  async create(dto: CreateEnergyRatingDto) {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const data = await this.prepare(tx, dto);
        return tx.energyRating.create({ data, include: ratingInclude });
      });
      return serializeRating(row);
    } catch (error) {
      this.conflict(error);
    }
  }

  async update(id: number, dto: UpdateEnergyRatingDto) {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const before = await tx.energyRating.findUnique({ where: { id } });
        if (!before) throw new NotFoundException('Energy rating not found.');
        const deactivationOnly =
          dto.isActive === false &&
          Object.entries(dto).every(
            ([key, value]) => key === 'isActive' || value === undefined,
          );
        if (deactivationOnly) {
          return tx.energyRating.update({
            where: { id },
            data: { isActive: false, activeKey: null },
            include: ratingInclude,
          });
        }
        const data = await this.prepare(tx, {
          ...before,
          uFactor: before.uFactor?.toString() ?? null,
          shgc: before.shgc?.toString() ?? null,
          vlt: before.vlt?.toString() ?? null,
          ...dto,
        });
        return tx.energyRating.update({
          where: { id },
          data,
          include: ratingInclude,
        });
      });
      return serializeRating(row);
    } catch (error) {
      this.conflict(error);
    }
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Config, Prisma } from '@prisma/client';
import {
  hasPanelCountSource,
  installationServiceRequiresPanelCount,
} from '@/installation/panel-count-capability';

@Injectable()
export class ConfigSService {
  constructor(private prisma: PrismaService) { }

  private readonly configInclude = {
    prod: true,
    category: true,
  } satisfies Prisma.ConfigInclude;

  private async validateConfigCategory(
    idProduct: number,
    categoryId?: number | null,
  ): Promise<void> {
    if (categoryId === undefined || categoryId === null) return;

    const category = await this.prisma.configCategory.findUnique({
      where: { id: categoryId },
      select: {
        id: true,
        idProduct: true,
        isActive: true,
      },
    });

    if (!category) {
      throw new BadRequestException('Config category not found.');
    }

    if (!category.isActive) {
      throw new BadRequestException('Config category is inactive.');
    }

    if (category.idProduct !== idProduct) {
      throw new BadRequestException(
        'Config category does not belong to the selected product.',
      );
    }
  }

  async config(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    const config = await this.prisma.config.findUnique({
      where,
      include: this.configInclude,
    });

    if (!config) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }

    return config;
  }

  async configs(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.ConfigWhereUniqueInput;
    where?: Prisma.ConfigWhereInput;
    orderBy?: Prisma.ConfigOrderByWithRelationInput | Prisma.ConfigOrderByWithRelationInput[];
  }): Promise<Config[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.config.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [
        { prod: { name: 'asc' } },
        { category: { sortOrder: 'asc' } },
        { category: { name: 'asc' } },
        { conf: 'asc' },
      ],
      include: this.configInclude,
    });
  }

  async createConfig(params: {
    data: Prisma.ConfigCreateInput;
    idProduct: number;
    categoryId?: number | null;
  }): Promise<Config> {
    const { data, idProduct, categoryId } = params;

    await this.validateConfigCategory(idProduct, categoryId);

    return this.prisma.config.create({
      data,
      include: this.configInclude,
    });
  }

  async updateConfig(params: {
    where: Prisma.ConfigWhereUniqueInput;
    data: Prisma.ConfigUpdateInput;
    idProduct?: number;
    categoryId?: number | null;
    fixedPanelCount?: number | null;
  }): Promise<Config> {
    const { where, data, idProduct, categoryId, fixedPanelCount } = params;

    const currentConfig = await this.prisma.config.findUnique({
      where,
      select: {
        id: true,
        idProduct: true,
      },
    });

    if (!currentConfig) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }

    const finalProductId = idProduct ?? currentConfig.idProduct;

    await this.validateConfigCategory(finalProductId, categoryId);

    if (fixedPanelCount === null && where.id !== undefined) {
      const sysConfs = await this.prisma.sysConf.findMany({
        where: { idConfig: where.id },
        select: {
          requiresPanelCount: true,
          system: { select: { name: true } },
          installationServices: {
            select: {
              service: {
                select: {
                  name: true,
                  billingUnit: true,
                  ruleMetric: true,
                },
              },
            },
          },
        },
      });

      const invalidSysConf = sysConfs.find(
        (sysConf) =>
          !hasPanelCountSource({
            fixedPanelCount: null,
            requiresPanelCount: sysConf.requiresPanelCount,
          }) &&
          sysConf.installationServices.some(({ service }) =>
            installationServiceRequiresPanelCount(service),
          ),
      );

      if (invalidSysConf) {
        const panelService = invalidSysConf.installationServices.find(
          ({ service }) => installationServiceRequiresPanelCount(service),
        )?.service;

        throw new BadRequestException(
          `Fixed Panel Count cannot be cleared while ${invalidSysConf.system.name} uses panel-based installation service "${panelService?.name ?? 'Installation'}". Enable manual Panel Count first or remove that service mapping.`,
        );
      }
    }

    try {
      return await this.prisma.config.update({
        data,
        where,
        include: this.configInclude,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Config with ID #${where.id} not found.`);
      }

      throw e;
    }
  }

  async deleteConfig(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    try {
      return await this.prisma.config.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Config with ID #${where.id} not found.`);
      }

      if (e?.code === 'P2003') {
        throw new BadRequestException(
          'This config is being used and cannot be deleted. Deactivate it instead.',
        );
      }

      throw e;
    }
  }

  async getConfigWithProduct(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    const config = await this.prisma.config.findUnique({
      where,
      include: this.configInclude,
    });

    if (!config) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }

    return config;
  }
}
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, System } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateSystemDto } from './dto/create-system.dto';
import { UpdateSystemDto } from './dto/update-system.dto';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';
import { UpdateSystemConfigOptionsDto } from './dto/update-system-config-options.dto';
import { UpdateSystemCrystalsDto } from './dto/update-system-crystals.dto';


@Injectable()
export class SystemsService {
  constructor(private prisma: PrismaService) { }

  async system(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    const system = await this.prisma.system.findUnique({
      where,
      include: {
        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },
        sysconfs: {
          include: {
            config: true,
          },
          orderBy: {
            config: {
              conf: 'asc',
            },
          },
        },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${where.id} not found.`);
    }
    return system;
  }

  async systems(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SystemWhereUniqueInput;
    where?: Prisma.SystemWhereInput;
    orderBy?: Prisma.SystemOrderByWithRelationInput;
  }): Promise<System[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.system.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      include: {
        brandProduct: {
          include: { brand: true, product: true },
        },
        sysconfs: {
          include: {
            config: true,
          },
          orderBy: {
            config: {
              conf: 'asc',
            },
          },
        },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
      },
    });
  }

  /** Devuelve todos los sistemas con sus configuraciones asociadas */
  async findAllWithConfigs(): Promise<System[]> {
    return this.prisma.system.findMany({
      include: {
        sysconfs: {
          include: {
            config: true,

            activeOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: 'asc',
              },
            },

            preparationOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: 'asc',
              },
            },

            sillOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: 'asc',
              },
            },

            reinforcementOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: 'asc',
              },
            },
          },
          orderBy: {
            config: {
              conf: 'asc',
            },
          },
        },

        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },

        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
      },
      orderBy: {
        id: 'asc',
      },
    });
  }

  async createSystem(systemData: CreateSystemDto): Promise<System> {
    const { name, idBrand, idProduct } = systemData;

    // Verifica que exista la pareja (brand, product) en la tabla pivote
    const brandProductExists = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: { idBrand, idProduct },
      },
      select: { idBrand: true, idProduct: true },
    });

    if (!brandProductExists) {
      throw new NotFoundException(
        `Brand/Product pair not found (brandId=${idBrand}, productId=${idProduct}).`,
      );
    }

    return this.prisma.system.create({
      data: { name, idBrand, idProduct, isActive: true },
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;

    try {
      return await this.prisma.system.update({ data, where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    try {
      return await this.prisma.system.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }

      if (e?.code === 'P2003') {
        throw new BadRequestException(
          'This system is being used and cannot be deleted. Deactivate it instead.',
        );
      }

      throw e;
    }
  }

  async getSystemWithConfigs(systemId: number): Promise<System> {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        sysconfs: {
          include: { config: true },
          orderBy: {
            config: {
              conf: 'asc',
            },
          },
        },
        brandProduct: { include: { product: true, brand: true } },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    return system;
  }

  async getSystemConfigOptions(systemId: number, configId: number) {
    const sysConf = await this.prisma.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: systemId,
          idConfig: configId,
        },
      },
      include: {
        activeOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        preparationOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        sillOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        reinforcementOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!sysConf) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    return {
      idSystem: systemId,
      idConfig: configId,
      allowScreen: sysConf.allowScreen,

      defaultActiveOptionId: sysConf.defaultActiveOptionId,
      defaultPreparationOptionId: sysConf.defaultPreparationOptionId,
      defaultSillOptionId: sysConf.defaultSillOptionId,
      defaultReinforcementOptionId: sysConf.defaultReinforcementOptionId,

      activeOptions: sysConf.activeOptions.map((x) => ({
        id: x.option.id,
        name: x.option.name,
        sortOrder: x.sortOrder,
      })),
      preparationOptions: sysConf.preparationOptions.map((x) => ({
        id: x.option.id,
        name: x.option.name,
        sortOrder: x.sortOrder,
      })),
      sillOptions: sysConf.sillOptions.map((x) => ({
        id: x.option.id,
        name: x.option.name,
        sortOrder: x.sortOrder,
      })),
      reinforcementOptions: sysConf.reinforcementOptions.map((x) => ({
        id: x.option.id,
        name: x.option.name,
        sortOrder: x.sortOrder,
      })),
    };
  }

  async getSystemConfigOptionsForManage(systemId: number, configId: number) {
    const sysConf = await this.prisma.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: systemId,
          idConfig: configId,
        },
      },
      include: {
        activeOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        preparationOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        sillOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        reinforcementOptions: {
          include: { option: true },
          orderBy: { sortOrder: 'asc' },
        },
        system: {
          select: {
            id: true,
            name: true,
          },
        },
        config: {
          select: {
            id: true,
            conf: true,
          },
        },
      },
    });

    if (!sysConf) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    const [
      activeOptionsCatalog,
      preparationOptionsCatalog,
      sillOptionsCatalog,
      reinforcementOptionsCatalog,
    ] = await Promise.all([
      this.prisma.activeOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.preparationOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.sillOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.reinforcementOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      idSystem: systemId,
      idConfig: configId,
      system: sysConf.system,
      config: sysConf.config,
      allowScreen: sysConf.allowScreen,

      defaultActiveOptionId: sysConf.defaultActiveOptionId,
      defaultPreparationOptionId: sysConf.defaultPreparationOptionId,
      defaultSillOptionId: sysConf.defaultSillOptionId,
      defaultReinforcementOptionId: sysConf.defaultReinforcementOptionId,

      selectedActiveOptionIds: sysConf.activeOptions.map((x) => x.option.id),
      selectedPreparationOptionIds: sysConf.preparationOptions.map(
        (x) => x.option.id,
      ),
      selectedSillOptionIds: sysConf.sillOptions.map((x) => x.option.id),
      selectedReinforcementOptionIds: sysConf.reinforcementOptions.map(
        (x) => x.option.id,
      ),

      activeOptionsCatalog,
      preparationOptionsCatalog,
      sillOptionsCatalog,
      reinforcementOptionsCatalog,
    };
  }

  async updateSystemConfigOptions(
    systemId: number,
    configId: number,
    data: UpdateSystemConfigOptionsDto,
  ) {
    const sysConf = await this.prisma.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: systemId,
          idConfig: configId,
        },
      },
      select: {
        idSystem: true,
        idConfig: true,
      },
    });

    if (!sysConf) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    const [
      validActiveOptions,
      validPreparationOptions,
      validSillOptions,
      validReinforcementOptions,
    ] = await Promise.all([
      this.prisma.activeOption.findMany({
        where: {
          id: { in: data.activeOptionIds },
          isActive: true,
        },
        select: { id: true },
      }),
      this.prisma.preparationOption.findMany({
        where: {
          id: { in: data.preparationOptionIds },
          isActive: true,
        },
        select: { id: true },
      }),
      this.prisma.sillOption.findMany({
        where: {
          id: { in: data.sillOptionIds },
          isActive: true,
        },
        select: { id: true },
      }),
      this.prisma.reinforcementOption.findMany({
        where: {
          id: { in: data.reinforcementOptionIds },
          isActive: true,
        },
        select: { id: true },
      }),
    ]);

    if (validActiveOptions.length !== data.activeOptionIds.length) {
      throw new BadRequestException(
        'One or more active options are invalid or inactive.',
      );
    }

    if (validPreparationOptions.length !== data.preparationOptionIds.length) {
      throw new BadRequestException(
        'One or more preparation options are invalid or inactive.',
      );
    }

    if (validSillOptions.length !== data.sillOptionIds.length) {
      throw new BadRequestException(
        'One or more sill options are invalid or inactive.',
      );
    }

    if (
      validReinforcementOptions.length !== data.reinforcementOptionIds.length
    ) {
      throw new BadRequestException(
        'One or more reinforcement options are invalid or inactive.',
      );
    }

    // 🔥 VALIDACIÓN DE DEFAULTS
    if (
      data.defaultActiveOptionId &&
      !data.activeOptionIds.includes(data.defaultActiveOptionId)
    ) {
      throw new BadRequestException(
        'Default active option must be one of the selected active options.',
      );
    }

    if (
      data.defaultPreparationOptionId &&
      !data.preparationOptionIds.includes(data.defaultPreparationOptionId)
    ) {
      throw new BadRequestException(
        'Default preparation option must be one of the selected preparation options.',
      );
    }

    if (
      data.defaultSillOptionId &&
      !data.sillOptionIds.includes(data.defaultSillOptionId)
    ) {
      throw new BadRequestException(
        'Default sill option must be one of the selected sill options.',
      );
    }

    if (
      data.defaultReinforcementOptionId &&
      !data.reinforcementOptionIds.includes(
        data.defaultReinforcementOptionId,
      )
    ) {
      throw new BadRequestException(
        'Default reinforcement option must be one of the selected reinforcement options.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sysConfActiveOption.deleteMany({
        where: {
          idSystem: systemId,
          idConfig: configId,
        },
      });

      await tx.sysConfPreparationOption.deleteMany({
        where: {
          idSystem: systemId,
          idConfig: configId,
        },
      });

      await tx.sysConfSillOption.deleteMany({
        where: {
          idSystem: systemId,
          idConfig: configId,
        },
      });

      await tx.sysConfReinforcementOption.deleteMany({
        where: {
          idSystem: systemId,
          idConfig: configId,
        },
      });

      if (data.activeOptionIds.length > 0) {
        await tx.sysConfActiveOption.createMany({
          data: data.activeOptionIds.map((optionId, index) => ({
            idSystem: systemId,
            idConfig: configId,
            optionId,
            sortOrder: index,
          })),
        });
      }

      if (data.preparationOptionIds.length > 0) {
        await tx.sysConfPreparationOption.createMany({
          data: data.preparationOptionIds.map((optionId, index) => ({
            idSystem: systemId,
            idConfig: configId,
            optionId,
            sortOrder: index,
          })),
        });
      }

      if (data.sillOptionIds.length > 0) {
        await tx.sysConfSillOption.createMany({
          data: data.sillOptionIds.map((optionId, index) => ({
            idSystem: systemId,
            idConfig: configId,
            optionId,
            sortOrder: index,
          })),
        });
      }

      if (data.reinforcementOptionIds.length > 0) {
        await tx.sysConfReinforcementOption.createMany({
          data: data.reinforcementOptionIds.map((optionId, index) => ({
            idSystem: systemId,
            idConfig: configId,
            optionId,
            sortOrder: index,
          })),
        });
      }

      // 🔥 GUARDAR DEFAULTS
      await tx.sysConf.update({
        where: {
          idSystem_idConfig: {
            idSystem: systemId,
            idConfig: configId,
          },
        },
        data: {
          defaultActiveOptionId: data.defaultActiveOptionId ?? null,
          defaultPreparationOptionId:
            data.defaultPreparationOptionId ?? null,
          defaultSillOptionId: data.defaultSillOptionId ?? null,
          defaultReinforcementOptionId:
            data.defaultReinforcementOptionId ?? null,
        },
      });
    });

    return this.getSystemConfigOptionsForManage(systemId, configId);
  }

  async getSystemCrystalsForManage(systemId: number) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: 'asc',
          },
        },
        defaultCrystal: true,
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const crystalsCatalog = await this.prisma.crystal.findMany({
      orderBy: {
        glass: 'asc',
      },
    });

    return {
      system: {
        id: system.id,
        name: system.name,
        idBrand: system.idBrand,
        idProduct: system.idProduct,
        brand: system.brandProduct.brand,
        product: system.brandProduct.product,
      },
      selectedCrystalIds: system.systemCrystals.map((x) => x.idCrystal),
      defaultCrystalId: system.defaultCrystalId,
      crystalsCatalog,
    };
  }

  async updateSystemCrystals(
    systemId: number,
    data: UpdateSystemCrystalsDto,
  ) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: { id: true },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const validCrystals = await this.prisma.crystal.findMany({
      where: {
        id: { in: data.crystalIds },
      },
      select: { id: true },
    });

    if (validCrystals.length !== data.crystalIds.length) {
      throw new BadRequestException('One or more glass types are invalid.');
    }

    if (
      data.defaultCrystalId &&
      !data.crystalIds.includes(data.defaultCrystalId)
    ) {
      throw new BadRequestException(
        'Default glass type must be one of the selected glass types.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.systemCrystal.deleteMany({
        where: {
          idSystem: systemId,
        },
      });

      if (data.crystalIds.length > 0) {
        await tx.systemCrystal.createMany({
          data: data.crystalIds.map((crystalId, index) => ({
            idSystem: systemId,
            idCrystal: crystalId,
            sortOrder: index,
          })),
        });
      }

      await tx.system.update({
        where: { id: systemId },
        data: {
          defaultCrystalId: data.defaultCrystalId ?? null,
        },
      });
    });

    return this.getSystemCrystalsForManage(systemId);
  }

  /**
   * Configs disponibles para un System:
   * - Mismo product que el System
   * - Excluye ya asociadas
   */
  async getAvailableConfigsForSystem(systemId: number) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: { idProduct: true, isActive: true },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const associatedConfigs = await this.prisma.sysConf.findMany({
      where: { idSystem: systemId },
      select: { idConfig: true },
    });

    const associatedConfigIds = associatedConfigs.map((c) => c.idConfig);

    return this.prisma.config.findMany({
      where: {
        idProduct: system.idProduct,
        isActive: true,
        id: associatedConfigIds.length
          ? { notIn: associatedConfigIds }
          : undefined,
      },
      orderBy: { conf: 'asc' },
    });
  }

  /**
   * Asocia una Config a un System con defensa en profundidad:
   * - Verifica existencia
   * - Valida que pertenecen al mismo Product
   * - Upsert idempotente
   * - allowScreen arranca en false por defecto
   */
  async addConfigToSystem(systemId: number, configId: number) {
    const [system, config] = await Promise.all([
      this.prisma.system.findUnique({
        where: { id: systemId },
        select: { id: true, idProduct: true, isActive: true },
      }),
      this.prisma.config.findUnique({
        where: { id: configId },
        select: { id: true, idProduct: true, isActive: true },
      }),
    ]);

    if (!system) throw new NotFoundException(`System #${systemId} not found.`);
    if (!config) throw new NotFoundException(`Config #${configId} not found.`);

    if (!system.isActive) {
      throw new BadRequestException('Inactive systems cannot be modified.');
    }

    if (!config.isActive) {
      throw new BadRequestException('Inactive configs cannot be linked to a system.');
    }

    if (system.idProduct !== config.idProduct) {
      throw new BadRequestException(
        `Config #${configId} belongs to a different product and cannot be linked to this system.`,
      );
    }

    await this.prisma.sysConf.upsert({
      where: { idSystem_idConfig: { idSystem: systemId, idConfig: configId } },
      update: {},
      create: {
        idSystem: systemId,
        idConfig: configId,
        allowScreen: false,
      },
    });

    return this.getSystemWithConfigs(systemId);
  }

  /**
   * Actualiza opciones de la relación System ⇄ Config
   */
  async updateSystemConfig(
    systemId: number,
    configId: number,
    data: UpdateSystemConfigDto,
  ) {
    const existingLink = await this.prisma.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: systemId,
          idConfig: configId,
        },
      },
      select: {
        idSystem: true,
        idConfig: true,
      },
    });

    if (!existingLink) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    await this.prisma.sysConf.update({
      where: {
        idSystem_idConfig: {
          idSystem: systemId,
          idConfig: configId,
        },
      },
      data: {
        allowScreen: data.allowScreen,
      },
    });

    return this.getSystemWithConfigs(systemId);
  }

  /** Elimina la asociación System ⇄ Config (404 si no existe) */
  async removeConfigFromSystem(
    systemId: number,
    configId: number,
  ): Promise<System> {
    try {
      await this.prisma.sysConf.delete({
        where: { idSystem_idConfig: { idSystem: systemId, idConfig: configId } },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
        );
      }
      throw e;
    }

    return this.getSystemWithConfigs(systemId);
  }
}
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DimensionMode,
  PricingComponentType,
  Prisma,
  ProductKind,
  System,
} from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";
import { CreateSystemDto } from "./dto/create-system.dto";
import { UpdateSystemDto } from "./dto/update-system.dto";
import { UpdateSystemConfigDto } from "./dto/update-system-config.dto";
import { UpdateSystemConfigOptionsDto } from "./dto/update-system-config-options.dto";
import { UpdateSystemCrystalsDto } from "./dto/update-system-crystals.dto";
import { UpdateSystemFrameColorsDto } from "./dto/update-system-frame-colors.dto";
import { UpdateSystemConfigPricingComponentsDto } from "./dto/update-system-config-pricing-components.dto";

@Injectable()
export class SystemsService {
  constructor(private prisma: PrismaService) {}

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
            config: {
              include: {
                category: true,
              },
            },
          },
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              config: {
                conf: "asc",
              },
            },
          ],
        },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
        systemFrameColors: {
          include: {
            frameColor: true,
          },
          orderBy: {
            sortOrder: "asc",
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
            config: {
              include: {
                category: true,
              },
            },
          },
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              config: {
                conf: "asc",
              },
            },
          ],
        },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
        systemFrameColors: {
          include: {
            frameColor: true,
          },
          orderBy: {
            sortOrder: "asc",
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
            config: {
              include: {
                category: true,
              },
            },
            activeOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: "asc",
              },
            },

            preparationOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: "asc",
              },
            },

            sillOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: "asc",
              },
            },
            reinforcementOptions: {
              include: {
                option: true,
              },
              orderBy: {
                sortOrder: "asc",
              },
            },
            pricingComponents: {
              select: {
                componentType: true,
                sourceConfigId: true,
                quantity: true,
              },
            },
          },
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              config: {
                conf: "asc",
              },
            },
          ],
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
            sortOrder: "asc",
          },
        },
        systemFrameColors: {
          include: {
            frameColor: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    });
  }

  async createSystem(systemData: CreateSystemDto): Promise<System> {
    const { name, idBrand, idProduct, allowHighBottom } = systemData;

    const brandProductExists = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: { idBrand, idProduct },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            kind: true,
            pricingMode: true,
          },
        },
      },
    });

    if (!brandProductExists) {
      throw new NotFoundException(
        `Brand/Product pair not found (brandId=${idBrand}, productId=${idProduct}).`,
      );
    }

    const isLinearMaterial =
      brandProductExists.product.kind === ProductKind.LINEAR_MATERIAL;

    if (isLinearMaterial && allowHighBottom) {
      throw new BadRequestException(
        "Linear material systems cannot allow high bottom.",
      );
    }

    return this.prisma.system.create({
      data: {
        name,
        idBrand,
        idProduct,
        isActive: true,
        allowHighBottom: isLinearMaterial ? false : (allowHighBottom ?? false),
      },
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;

    const current = await this.prisma.system.findUnique({
      where,
      select: {
        id: true,
        idBrand: true,
        idProduct: true,
      },
    });

    if (!current) {
      throw new NotFoundException(`System with ID #${where.id} not found.`);
    }

    const nextIdBrand = data.idBrand ?? current.idBrand;
    const nextIdProduct = data.idProduct ?? current.idProduct;

    const brandProduct = await this.prisma.brandProduct.findUnique({
      where: {
        idBrand_idProduct: {
          idBrand: nextIdBrand,
          idProduct: nextIdProduct,
        },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            kind: true,
            pricingMode: true,
          },
        },
      },
    });

    if (!brandProduct) {
      throw new NotFoundException(
        `Brand/Product pair not found (brandId=${nextIdBrand}, productId=${nextIdProduct}).`,
      );
    }

    const isLinearMaterial =
      brandProduct.product.kind === ProductKind.LINEAR_MATERIAL;

    if (isLinearMaterial && data.allowHighBottom) {
      throw new BadRequestException(
        "Linear material systems cannot allow high bottom.",
      );
    }

    try {
      return await this.prisma.system.update({
        where,
        data: {
          ...data,
          allowHighBottom: isLinearMaterial ? false : data.allowHighBottom,
        },
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    try {
      return await this.prisma.system.delete({ where });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`System with ID #${where.id} not found.`);
      }

      if (e?.code === "P2003") {
        throw new BadRequestException(
          "This system is being used and cannot be deleted. Deactivate it instead.",
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
          include: {
            config: {
              include: {
                category: true,
              },
            },
          },
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              config: {
                conf: "asc",
              },
            },
          ],
        },
        brandProduct: { include: { product: true, brand: true } },
        defaultCrystal: true,
        systemCrystals: {
          include: {
            crystal: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
        systemFrameColors: {
          include: {
            frameColor: true,
          },
          orderBy: {
            sortOrder: "asc",
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
          orderBy: { sortOrder: "asc" },
        },
        preparationOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
        },
        sillOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
        },
        reinforcementOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
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
      isSelectableInEstimate: sysConf.isSelectableInEstimate,

      dimensionMode: sysConf.dimensionMode,
      minimumBillableHeightIn: sysConf.minimumBillableHeightIn,
      requiresWidth: sysConf.requiresWidth,
      requiresHeight: sysConf.requiresHeight,
      requiresHeightLeft: sysConf.requiresHeightLeft,
      requiresHeightRight: sysConf.requiresHeightRight,
      requiresLegHeight: sysConf.requiresLegHeight,
      requiresDoorWidth: sysConf.requiresDoorWidth,
      requiresDoorHeight: sysConf.requiresDoorHeight,
      requiresLeftSideliteWidth: sysConf.requiresLeftSideliteWidth,
      requiresRightSideliteWidth: sysConf.requiresRightSideliteWidth,
      requiresLeftPanels: sysConf.requiresLeftPanels,
      requiresRightPanels: sysConf.requiresRightPanels,
      requiresPanelCount: sysConf.requiresPanelCount,
      requiresHorizontalHeights: sysConf.requiresHorizontalHeights,

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
          orderBy: { sortOrder: "asc" },
        },
        preparationOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
        },
        sillOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
        },
        reinforcementOptions: {
          include: { option: true },
          orderBy: { sortOrder: "asc" },
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
            category: {
              select: {
                id: true,
                name: true,
                sortOrder: true,
                isActive: true,
              },
            },
          },
        },
        pricingComponents: {
          include: {
            sourceSysConf: {
              select: {
                idConfig: true,
                config: {
                  select: {
                    id: true,
                    conf: true,
                    categoryId: true,
                    isActive: true,
                    category: {
                      select: {
                        id: true,
                        name: true,
                        sortOrder: true,
                        isActive: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: {
            componentType: "asc",
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
      pricingSourceSysConfs,
    ] = await Promise.all([
      this.prisma.activeOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.preparationOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.sillOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.reinforcementOption.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.sysConf.findMany({
        where: {
          idSystem: systemId,
          idConfig: {
            not: configId,
          },
          config: {
            isActive: true,
          },

          // Solo configuraciones con precio directo pueden ser fuentes.
          pricingComponents: {
            none: {},
          },
        },
        select: {
          idConfig: true,
          sortOrder: true,
          config: {
            select: {
              id: true,
              conf: true,
              categoryId: true,
              isActive: true,
              category: {
                select: {
                  id: true,
                  name: true,
                  sortOrder: true,
                  isActive: true,
                },
              },
            },
          },
        },
        orderBy: [
          {
            sortOrder: "asc",
          },
          {
            config: {
              conf: "asc",
            },
          },
        ],
      }),
    ]);

    return {
      idSystem: systemId,
      idConfig: configId,
      system: sysConf.system,
      config: sysConf.config,
      allowScreen: sysConf.allowScreen,
      isSelectableInEstimate: sysConf.isSelectableInEstimate,

      dimensionMode: sysConf.dimensionMode,
      minimumBillableHeightIn: sysConf.minimumBillableHeightIn,
      requiresWidth: sysConf.requiresWidth,
      requiresHeight: sysConf.requiresHeight,
      requiresHeightLeft: sysConf.requiresHeightLeft,
      requiresHeightRight: sysConf.requiresHeightRight,
      requiresLegHeight: sysConf.requiresLegHeight,
      requiresDoorWidth: sysConf.requiresDoorWidth,
      requiresDoorHeight: sysConf.requiresDoorHeight,
      requiresLeftSideliteWidth: sysConf.requiresLeftSideliteWidth,
      requiresRightSideliteWidth: sysConf.requiresRightSideliteWidth,
      requiresLeftPanels: sysConf.requiresLeftPanels,
      requiresRightPanels: sysConf.requiresRightPanels,
      requiresPanelCount: sysConf.requiresPanelCount,
      requiresHorizontalHeights: sysConf.requiresHorizontalHeights,

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

      pricingComponents: sysConf.pricingComponents.map((component) => ({
        componentType: component.componentType,
        sourceConfigId: component.sourceConfigId,
        quantity: component.quantity,
        sourceConfig: component.sourceSysConf.config,
      })),

      pricingSourceConfigsCatalog: pricingSourceSysConfs.map((source) => ({
        idConfig: source.idConfig,
        config: source.config,
      })),

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
        system: {
          select: {
            defaultConfigId: true,
            brandProduct: {
              select: {
                product: {
                  select: {
                    kind: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!sysConf) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    if (
      data.isSelectableInEstimate === false &&
      sysConf.system.defaultConfigId === configId
    ) {
      throw new BadRequestException(
        "Select another default configuration before removing this configuration from estimates.",
      );
    }

    const isLinearMaterial =
      sysConf.system.brandProduct.product.kind === ProductKind.LINEAR_MATERIAL;

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
        "One or more active options are invalid or inactive.",
      );
    }

    if (validPreparationOptions.length !== data.preparationOptionIds.length) {
      throw new BadRequestException(
        "One or more preparation options are invalid or inactive.",
      );
    }

    if (validSillOptions.length !== data.sillOptionIds.length) {
      throw new BadRequestException(
        "One or more sill options are invalid or inactive.",
      );
    }

    if (
      validReinforcementOptions.length !== data.reinforcementOptionIds.length
    ) {
      throw new BadRequestException(
        "One or more reinforcement options are invalid or inactive.",
      );
    }

    // VALIDACIÓN DE DEFAULTS
    if (
      data.defaultActiveOptionId &&
      !data.activeOptionIds.includes(data.defaultActiveOptionId)
    ) {
      throw new BadRequestException(
        "Default active option must be one of the selected active options.",
      );
    }

    if (
      data.defaultPreparationOptionId &&
      !data.preparationOptionIds.includes(data.defaultPreparationOptionId)
    ) {
      throw new BadRequestException(
        "Default preparation option must be one of the selected preparation options.",
      );
    }

    if (
      data.defaultSillOptionId &&
      !data.sillOptionIds.includes(data.defaultSillOptionId)
    ) {
      throw new BadRequestException(
        "Default sill option must be one of the selected sill options.",
      );
    }

    if (
      data.defaultReinforcementOptionId &&
      !data.reinforcementOptionIds.includes(data.defaultReinforcementOptionId)
    ) {
      throw new BadRequestException(
        "Default reinforcement option must be one of the selected reinforcement options.",
      );
    }

    const dimensionUpdateData = isLinearMaterial
      ? {
          dimensionMode: DimensionMode.STANDARD,
          requiresWidth: true,
          requiresHeight: false,
          requiresHeightLeft: false,
          requiresHeightRight: false,
          requiresLegHeight: false,
          requiresDoorWidth: false,
          requiresDoorHeight: false,
          requiresLeftSideliteWidth: false,
          requiresRightSideliteWidth: false,
          requiresLeftPanels: false,
          requiresRightPanels: false,
          requiresPanelCount: false,
          requiresHorizontalHeights: false,
        }
      : {
          ...(data.dimensionMode !== undefined
            ? { dimensionMode: data.dimensionMode }
            : {}),

          ...(data.requiresWidth !== undefined
            ? { requiresWidth: data.requiresWidth }
            : {}),
          ...(data.requiresHeight !== undefined
            ? { requiresHeight: data.requiresHeight }
            : {}),
          ...(data.requiresHeightLeft !== undefined
            ? { requiresHeightLeft: data.requiresHeightLeft }
            : {}),
          ...(data.requiresHeightRight !== undefined
            ? { requiresHeightRight: data.requiresHeightRight }
            : {}),
          ...(data.requiresLegHeight !== undefined
            ? { requiresLegHeight: data.requiresLegHeight }
            : {}),
          ...(data.requiresDoorWidth !== undefined
            ? { requiresDoorWidth: data.requiresDoorWidth }
            : {}),
          ...(data.requiresDoorHeight !== undefined
            ? { requiresDoorHeight: data.requiresDoorHeight }
            : {}),
          ...(data.requiresLeftSideliteWidth !== undefined
            ? { requiresLeftSideliteWidth: data.requiresLeftSideliteWidth }
            : {}),
          ...(data.requiresRightSideliteWidth !== undefined
            ? { requiresRightSideliteWidth: data.requiresRightSideliteWidth }
            : {}),
          ...(data.requiresLeftPanels !== undefined
            ? { requiresLeftPanels: data.requiresLeftPanels }
            : {}),
          ...(data.requiresRightPanels !== undefined
            ? { requiresRightPanels: data.requiresRightPanels }
            : {}),
          ...(data.requiresPanelCount !== undefined
            ? { requiresPanelCount: data.requiresPanelCount }
            : {}),
          ...(data.requiresHorizontalHeights !== undefined
            ? { requiresHorizontalHeights: data.requiresHorizontalHeights }
            : {}),
        };

    const minimumBillableHeightUpdateData = isLinearMaterial
      ? {
          minimumBillableHeightIn: null,
        }
      : data.minimumBillableHeightIn !== undefined
        ? {
            minimumBillableHeightIn: data.minimumBillableHeightIn,
          }
        : {};

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

      //  GUARDAR DEFAULTS
      await tx.sysConf.update({
        where: {
          idSystem_idConfig: {
            idSystem: systemId,
            idConfig: configId,
          },
        },
        data: {
          defaultActiveOptionId: data.defaultActiveOptionId ?? null,
          defaultPreparationOptionId: data.defaultPreparationOptionId ?? null,
          defaultSillOptionId: data.defaultSillOptionId ?? null,
          defaultReinforcementOptionId:
            data.defaultReinforcementOptionId ?? null,

          ...(data.isSelectableInEstimate !== undefined
            ? {
                isSelectableInEstimate: data.isSelectableInEstimate,
              }
            : {}),

          ...dimensionUpdateData,
          ...minimumBillableHeightUpdateData,
        },
      });
    });

    return this.getSystemConfigOptionsForManage(systemId, configId);
  }

  async updateSystemConfigPricingComponents(
    systemId: number,
    configId: number,
    data: UpdateSystemConfigPricingComponentsDto,
  ) {
    const componentTypes = data.components.map(
      (component) => component.componentType,
    );

    if (new Set(componentTypes).size !== componentTypes.length) {
      throw new BadRequestException(
        "Pricing component types cannot be duplicated.",
      );
    }

    const sourceConfigIds = data.components.map(
      (component) => component.sourceConfigId,
    );

    if (sourceConfigIds.includes(configId)) {
      throw new BadRequestException(
        "A configuration cannot use itself as a pricing source.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const parentSysConf = await tx.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: systemId,
            idConfig: configId,
          },
        },
        select: {
          idSystem: true,
          idConfig: true,
          dimensionMode: true,
          system: {
            select: {
              brandProduct: {
                select: {
                  product: {
                    select: {
                      kind: true,
                    },
                  },
                },
              },
            },
          },
          usedAsPricingSource: {
            select: {
              idSystem: true,
              idConfig: true,
            },
          },
        },
      });

      if (!parentSysConf) {
        throw new NotFoundException(
          `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
        );
      }

      const isLinearMaterial =
        parentSysConf.system.brandProduct.product.kind ===
        ProductKind.LINEAR_MATERIAL;

      if (isLinearMaterial && data.components.length > 0) {
        throw new BadRequestException(
          "Linear material configurations cannot use component pricing.",
        );
      }

      if (
        data.components.length > 0 &&
        parentSysConf.usedAsPricingSource.length > 0
      ) {
        throw new BadRequestException(
          "This configuration is already used as a pricing source and cannot use component pricing.",
        );
      }

      const componentWithInvalidQuantity = data.components.find(
        (component) =>
          component.componentType !== PricingComponentType.SIDELITE &&
          component.quantity != null,
      );

      if (componentWithInvalidQuantity) {
        throw new BadRequestException(
          "Quantity can only be assigned to the SIDELITE pricing component.",
        );
      }

      const sideliteComponent = data.components.find(
        (component) =>
          component.componentType === PricingComponentType.SIDELITE,
      );

      if (
        parentSysConf.dimensionMode === DimensionMode.ECO_WINDOWS_DOOR &&
        sideliteComponent &&
        sideliteComponent.quantity == null
      ) {
        throw new BadRequestException(
          "Sidelite Quantity is required for Eco Windows component pricing.",
        );
      }

      if (
        parentSysConf.dimensionMode !== DimensionMode.ECO_WINDOWS_DOOR &&
        sideliteComponent?.quantity != null
      ) {
        throw new BadRequestException(
          "Sidelite Quantity is only configurable for Eco Windows door systems.",
        );
      }

      if (data.components.length > 0) {
        const [directPricingRuleCount, pricingRangeCount] = await Promise.all([
          tx.pricingRule.count({
            where: {
              idSystem: systemId,
              idConfig: configId,
            },
          }),
          tx.pricingRange.count({
            where: {
              idSystem: systemId,
              idConfig: configId,
            },
          }),
        ]);

        if (directPricingRuleCount > 0 || pricingRangeCount > 0) {
          throw new BadRequestException(
            "Remove the direct pricing rules and pricing ranges for this configuration before enabling component pricing.",
          );
        }

        const uniqueSourceConfigIds = [...new Set(sourceConfigIds)];

        const sourceSysConfs = await tx.sysConf.findMany({
          where: {
            idSystem: systemId,
            idConfig: {
              in: uniqueSourceConfigIds,
            },
          },
          select: {
            idConfig: true,
            config: {
              select: {
                conf: true,
                isActive: true,
              },
            },
            pricingComponents: {
              select: {
                componentType: true,
              },
            },
          },
        });

        if (sourceSysConfs.length !== uniqueSourceConfigIds.length) {
          throw new BadRequestException(
            "One or more pricing source configurations are not associated with this system.",
          );
        }

        const inactiveSource = sourceSysConfs.find(
          (source) => !source.config.isActive,
        );

        if (inactiveSource) {
          throw new BadRequestException(
            `Pricing source configuration ${inactiveSource.config.conf} is inactive.`,
          );
        }

        const nestedSource = sourceSysConfs.find(
          (source) => source.pricingComponents.length > 0,
        );

        if (nestedSource) {
          throw new BadRequestException(
            `Pricing source configuration ${nestedSource.config.conf} already uses component pricing.`,
          );
        }
      }

      await tx.sysConfPricingComponent.deleteMany({
        where: {
          idSystem: systemId,
          idConfig: configId,
        },
      });

      if (data.components.length > 0) {
        await tx.sysConfPricingComponent.createMany({
          data: data.components.map((component) => ({
            idSystem: systemId,
            idConfig: configId,
            componentType: component.componentType,
            sourceConfigId: component.sourceConfigId,
            quantity: component.quantity ?? null,
          })),
        });
      }
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
            sortOrder: "asc",
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
        glass: "asc",
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

  async updateSystemCrystals(systemId: number, data: UpdateSystemCrystalsDto) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: {
        id: true,
        brandProduct: {
          select: {
            product: {
              select: {
                kind: true,
              },
            },
          },
        },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    if (system.brandProduct.product.kind === ProductKind.LINEAR_MATERIAL) {
      throw new BadRequestException(
        "Linear material systems do not use glass options.",
      );
    }

    const validCrystals = await this.prisma.crystal.findMany({
      where: {
        id: { in: data.crystalIds },
      },
      select: { id: true },
    });

    if (validCrystals.length !== data.crystalIds.length) {
      throw new BadRequestException("One or more glass types are invalid.");
    }

    if (
      data.defaultCrystalId &&
      !data.crystalIds.includes(data.defaultCrystalId)
    ) {
      throw new BadRequestException(
        "Default glass type must be one of the selected glass types.",
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

  async getSystemFrameColorsForManage(systemId: number) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      include: {
        brandProduct: {
          include: {
            brand: true,
            product: true,
          },
        },
        systemFrameColors: {
          include: {
            frameColor: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const frameColorsCatalog = await this.prisma.frameColor.findMany({
      orderBy: {
        color: "asc",
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
      selectedFrameColorIds: system.systemFrameColors.map(
        (x) => x.idFrameColor,
      ),
      frameColorsCatalog,
    };
  }

  async updateSystemFrameColors(
    systemId: number,
    data: UpdateSystemFrameColorsDto,
  ) {
    const system = await this.prisma.system.findUnique({
      where: { id: systemId },
      select: { id: true },
    });

    if (!system) {
      throw new NotFoundException(`System with ID #${systemId} not found.`);
    }

    const validFrameColors = await this.prisma.frameColor.findMany({
      where: {
        id: { in: data.frameColorIds },
      },
      select: { id: true },
    });

    if (validFrameColors.length !== data.frameColorIds.length) {
      throw new BadRequestException("One or more frame colors are invalid.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.systemFrameColor.deleteMany({
        where: {
          idSystem: systemId,
        },
      });

      if (data.frameColorIds.length > 0) {
        await tx.systemFrameColor.createMany({
          data: data.frameColorIds.map((frameColorId, index) => ({
            idSystem: systemId,
            idFrameColor: frameColorId,
            sortOrder: index,
          })),
        });
      }
    });

    return this.getSystemFrameColorsForManage(systemId);
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
      include: {
        category: true,
      },
      orderBy: [
        { category: { sortOrder: "asc" } },
        { category: { name: "asc" } },
        { conf: "asc" },
      ],
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
        select: {
          id: true,
          idProduct: true,
          isActive: true,
          brandProduct: {
            select: {
              product: {
                select: {
                  id: true,
                  name: true,
                  kind: true,
                  pricingMode: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.config.findUnique({
        where: { id: configId },
        select: { id: true, idProduct: true, isActive: true },
      }),
    ]);

    if (!system) throw new NotFoundException(`System #${systemId} not found.`);
    if (!config) throw new NotFoundException(`Config #${configId} not found.`);

    if (!system.isActive) {
      throw new BadRequestException("Inactive systems cannot be modified.");
    }

    if (!config.isActive) {
      throw new BadRequestException(
        "Inactive configs cannot be linked to a system.",
      );
    }

    if (system.idProduct !== config.idProduct) {
      throw new BadRequestException(
        `Config #${configId} belongs to a different product and cannot be linked to this system.`,
      );
    }

    const isLinearMaterial =
      system.brandProduct.product.kind === ProductKind.LINEAR_MATERIAL;

    await this.prisma.$transaction(async (tx) => {
      const currentMaxOrder = await tx.sysConf.aggregate({
        where: {
          idSystem: systemId,
        },
        _max: {
          sortOrder: true,
        },
      });

      const nextSortOrder = (currentMaxOrder._max.sortOrder ?? -1) + 1;

      await tx.sysConf.upsert({
        where: {
          idSystem_idConfig: {
            idSystem: systemId,
            idConfig: configId,
          },
        },
        update: {},
        create: {
          idSystem: systemId,
          idConfig: configId,

          sortOrder: nextSortOrder,
          allowScreen: false,
          dimensionMode: DimensionMode.STANDARD,

          requiresWidth: isLinearMaterial,
          requiresHeight: false,
          requiresHeightLeft: false,
          requiresHeightRight: false,
          requiresLegHeight: false,
          requiresDoorWidth: false,
          requiresDoorHeight: false,
          requiresLeftSideliteWidth: false,
          requiresRightSideliteWidth: false,
          requiresLeftPanels: false,
          requiresRightPanels: false,
          requiresPanelCount: false,
          requiresHorizontalHeights: false,
        },
      });
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
        isSelectableInEstimate: true,
        system: {
          select: {
            defaultConfigId: true,
            brandProduct: {
              select: {
                product: {
                  select: {
                    kind: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!existingLink) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    if (data.isDefault === true && !existingLink.isSelectableInEstimate) {
      throw new BadRequestException(
        "A configuration that is not available in estimates cannot be set as default.",
      );
    }

    const isLinearMaterial =
      existingLink.system.brandProduct.product.kind ===
      ProductKind.LINEAR_MATERIAL;

    if (isLinearMaterial && data.allowScreen === true) {
      throw new BadRequestException(
        "Linear material configs cannot allow screen.",
      );
    }

    const sysConfUpdateData: Prisma.SysConfUpdateInput = {
      ...(data.allowScreen !== undefined
        ? {
            allowScreen: isLinearMaterial ? false : data.allowScreen,
          }
        : {}),

      ...(data.sortOrder !== undefined
        ? {
            sortOrder: data.sortOrder,
          }
        : {}),
    };

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(sysConfUpdateData).length > 0) {
        await tx.sysConf.update({
          where: {
            idSystem_idConfig: {
              idSystem: systemId,
              idConfig: configId,
            },
          },
          data: sysConfUpdateData,
        });
      }

      if (data.isDefault === true) {
        await tx.system.update({
          where: {
            id: systemId,
          },
          data: {
            defaultConfigId: configId,
          },
        });
      }

      if (
        data.isDefault === false &&
        existingLink.system.defaultConfigId === configId
      ) {
        await tx.system.update({
          where: {
            id: systemId,
          },
          data: {
            defaultConfigId: null,
          },
        });
      }
    });

    return this.getSystemWithConfigs(systemId);
  }

  /** Elimina la asociación System ⇄ Config (404 si no existe) */
  async removeConfigFromSystem(
    systemId: number,
    configId: number,
  ): Promise<System> {
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
        system: {
          select: {
            defaultConfigId: true,
          },
        },
      },
    });

    if (!existingLink) {
      throw new NotFoundException(
        `System/Config link not found (systemId=${systemId}, configId=${configId}).`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (existingLink.system.defaultConfigId === configId) {
        await tx.system.update({
          where: {
            id: systemId,
          },
          data: {
            defaultConfigId: null,
          },
        });
      }

      await tx.sysConf.delete({
        where: {
          idSystem_idConfig: {
            idSystem: systemId,
            idConfig: configId,
          },
        },
      });
    });

    return this.getSystemWithConfigs(systemId);
  }
}

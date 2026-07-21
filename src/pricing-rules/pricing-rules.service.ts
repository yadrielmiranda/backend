import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { CreatePricingRuleDto } from "./dto/create-pricing-rule.dto";
import { UpdatePricingRuleDto } from "./dto/update-pricing-rule.dto";
import { AvailablePricingRuleCrystalsQueryDto } from "./dto/available-pricing-rule-crystals-query.dto";
import { Prisma } from "@prisma/client";
import { LogsService } from "@/logs/logs.service";
import type { AuthUser } from "@/auth/types/auth-user.type";
import { getRoleName } from "@/auth/utils/get-role-name";

@Injectable()
export class PricingRulesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) {}

  private async validateDirectPricingTarget(data: {
    idBrand: number;
    idProduct: number;
    idSystem: number;
    idConfig: number;
    idCrystal: number;
  }) {
    const [system, sysConf] = await Promise.all([
      this.prisma.system.findUnique({
        where: {
          id: data.idSystem,
        },
        select: {
          id: true,
          idBrand: true,
          idProduct: true,
        },
      }),

      this.prisma.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: data.idSystem,
            idConfig: data.idConfig,
          },
        },
        select: {
          pricingComponents: {
            select: {
              componentType: true,
            },
          },
        },
      }),
    ]);

    if (!system) {
      throw new BadRequestException("The selected system does not exist.");
    }

    if (
      system.idBrand !== data.idBrand ||
      system.idProduct !== data.idProduct
    ) {
      throw new BadRequestException(
        "The selected system does not belong to the selected brand and product.",
      );
    }

    if (!sysConf) {
      throw new BadRequestException(
        "The selected configuration is not associated with the selected system.",
      );
    }

    if (sysConf.pricingComponents.length > 0) {
      throw new BadRequestException(
        "Component-priced configurations cannot have direct pricing rules.",
      );
    }

    const rangeRule = await this.prisma.pricingRangeRule.findFirst({
      where: {
        idCrystal: data.idCrystal,
        range: {
          is: {
            idSystem: data.idSystem,
            idConfig: data.idConfig,
          },
        },
      },
      select: {
        id: true,
      },
    });

    if (rangeRule) {
      throw new BadRequestException(
        "Remove the pricing ranges for this crystal before creating a direct pricing rule.",
      );
    }
  }

  private async validateCrystalForSystem(idSystem: number, idCrystal: number) {
    const systemCrystal = await this.prisma.systemCrystal.findUnique({
      where: {
        idSystem_idCrystal: {
          idSystem,
          idCrystal,
        },
      },
      select: {
        crystal: {
          select: {
            isActive: true,
          },
        },
      },
    });

    if (!systemCrystal) {
      throw new BadRequestException(
        "The selected crystal is not associated with the selected system.",
      );
    }

    if (!systemCrystal.crystal.isActive) {
      throw new BadRequestException("The selected crystal is inactive.");
    }
  }

  async findAvailableCrystals(query: AvailablePricingRuleCrystalsQueryDto) {
    const [system, sysConf] = await Promise.all([
      this.prisma.system.findUnique({
        where: {
          id: query.idSystem,
        },
        select: {
          id: true,
          idBrand: true,
          idProduct: true,
        },
      }),

      this.prisma.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: query.idSystem,
            idConfig: query.idConfig,
          },
        },
        select: {
          pricingComponents: {
            select: {
              componentType: true,
            },
          },
        },
      }),
    ]);

    if (!system) {
      throw new BadRequestException("The selected system does not exist.");
    }

    if (!sysConf) {
      throw new BadRequestException(
        "The selected configuration is not associated with the selected system.",
      );
    }

    if (sysConf.pricingComponents.length > 0) {
      throw new BadRequestException(
        "Component-priced configurations cannot have direct pricing rules.",
      );
    }

    if (query.excludeRuleId) {
      const excludedRule = await this.prisma.pricingRule.findUnique({
        where: {
          id: query.excludeRuleId,
        },
        select: {
          idBrand: true,
          idProduct: true,
          idSystem: true,
          idConfig: true,
        },
      });

      if (!excludedRule) {
        throw new NotFoundException(
          `Pricing Rule with ID #${query.excludeRuleId} not found.`,
        );
      }

      const belongsToRequestedCombination =
        excludedRule.idBrand === system.idBrand &&
        excludedRule.idProduct === system.idProduct &&
        excludedRule.idSystem === query.idSystem &&
        excludedRule.idConfig === query.idConfig;

      if (!belongsToRequestedCombination) {
        throw new BadRequestException(
          "The excluded pricing rule does not belong to the requested combination.",
        );
      }
    }

    const [systemCrystals, existingRules, existingRangeRules] =
      await Promise.all([
        this.prisma.systemCrystal.findMany({
          where: {
            idSystem: query.idSystem,
            crystal: {
              is: {
                isActive: true,
              },
            },
          },
          select: {
            idCrystal: true,
            sortOrder: true,
            crystal: {
              select: {
                id: true,
                glass: true,
                isActive: true,
              },
            },
          },
        }),

        this.prisma.pricingRule.findMany({
          where: {
            idBrand: system.idBrand,
            idProduct: system.idProduct,
            idSystem: query.idSystem,
            idConfig: query.idConfig,

            ...(query.excludeRuleId
              ? {
                  id: {
                    not: query.excludeRuleId,
                  },
                }
              : {}),
          },
          select: {
            idCrystal: true,
          },
        }),

        this.prisma.pricingRangeRule.findMany({
          where: {
            range: {
              is: {
                idSystem: query.idSystem,
                idConfig: query.idConfig,
              },
            },
          },
          select: {
            idCrystal: true,
          },
          distinct: ["idCrystal"],
        }),
      ]);

    const usedCrystalIds = new Set(
      [...existingRules, ...existingRangeRules].map((rule) => rule.idCrystal),
    );

    return systemCrystals
      .filter((link) => !usedCrystalIds.has(link.idCrystal))
      .sort((a, b) => {
        const sortDifference = a.sortOrder - b.sortOrder;

        if (sortDifference !== 0) {
          return sortDifference;
        }

        return a.crystal.glass.localeCompare(b.crystal.glass);
      })
      .map((link) => link.crystal);
  }

  private async findOneOrThrow(id: number) {
    const rule = await this.prisma.pricingRule.findUnique({
      where: { id },
      include: {
        brand: { select: { name: true } },
        product: { select: { name: true } },
        system: { select: { name: true } },
        config: { select: { conf: true } },
        crystal: { select: { glass: true } },
      },
    });

    if (!rule)
      throw new NotFoundException(`Pricing Rule with ID #${id} not found.`);
    return rule;
  }

  private toSnapshot(rule: any) {
    return {
      id: rule.id,
      idBrand: rule.idBrand,
      idProduct: rule.idProduct,
      idSystem: rule.idSystem,
      idConfig: rule.idConfig,
      idCrystal: rule.idCrystal,

      // comentario en español: convertir Decimal a string
      // para conservar la precisión completa en los logs.
      costoA: rule.costoA?.toString() ?? null,
      costoB: rule.costoB?.toString() ?? null,
      costoC: rule.costoC?.toString() ?? null,

      brandName: rule.brand?.name ?? null,
      productName: rule.product?.name ?? null,
      systemName: rule.system?.name ?? null,
      configName: rule.config?.conf ?? null,
      crystalName: rule.crystal?.glass ?? null,
    };
  }

  async create(dto: CreatePricingRuleDto, actor: AuthUser) {
    await Promise.all([
      this.validateDirectPricingTarget(dto),
      this.validateCrystalForSystem(dto.idSystem, dto.idCrystal),
    ]);

    const existingRule = await this.prisma.pricingRule.findUnique({
      where: {
        idBrand_idProduct_idSystem_idConfig_idCrystal: {
          idBrand: dto.idBrand,
          idProduct: dto.idProduct,
          idSystem: dto.idSystem,
          idConfig: dto.idConfig,
          idCrystal: dto.idCrystal,
        },
      },
    });

    if (existingRule) {
      throw new ConflictException(
        "A pricing rule for this exact combination already exists.",
      );
    }

    const created = await this.prisma.pricingRule.create({
      data: {
        idBrand: dto.idBrand,
        idProduct: dto.idProduct,
        idSystem: dto.idSystem,
        idConfig: dto.idConfig,
        idCrystal: dto.idCrystal,
        costoA: new Prisma.Decimal(dto.costoA),
        costoB: new Prisma.Decimal(dto.costoB),
        costoC: new Prisma.Decimal(dto.costoC),
      },
    });

    const createdFull = await this.prisma.pricingRule.findUnique({
      where: { id: created.id },
      include: {
        brand: { select: { name: true } },
        product: { select: { name: true } },
        system: { select: { name: true } },
        config: { select: { conf: true } },
        crystal: { select: { glass: true } },
      },
    });

    await this.logs.log({
      action: "CREATE",
      entityType: "PricingRule",
      entityId: created.id,
      userId: actor.id,
      message: `PricingRule created (#${created.id})`,
      after: this.toSnapshot(createdFull ?? created),
      meta: {
        source: "PricingRulesService.create",
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
      },
    });

    return created;
  }

  findAll() {
    return this.prisma.pricingRule.findMany({
      include: {
        brand: { select: { name: true } },
        product: { select: { name: true } },
        system: { select: { name: true } },
        config: { select: { conf: true } },
        crystal: { select: { glass: true } },
      },
      orderBy: { id: "asc" },
    });
  }

  async findOne(id: number) {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id } });
    if (!rule)
      throw new NotFoundException(`Pricing Rule with ID #${id} not found.`);
    return rule;
  }

  async update(id: number, dto: UpdatePricingRuleDto, actor: AuthUser) {
    const beforeFull = await this.findOneOrThrow(id);
    const target = {
      idBrand: dto.idBrand ?? beforeFull.idBrand,
      idProduct: dto.idProduct ?? beforeFull.idProduct,
      idSystem: dto.idSystem ?? beforeFull.idSystem,
      idConfig: dto.idConfig ?? beforeFull.idConfig,
      idCrystal: dto.idCrystal ?? beforeFull.idCrystal,
    };

    await Promise.all([
      this.validateDirectPricingTarget(target),
      this.validateCrystalForSystem(target.idSystem, target.idCrystal),
    ]);

    try {
      const { costoA, costoB, costoC, ...otherFields } = dto;

      // comentario en español: convertir los coeficientes directamente
      // desde string a Decimal para conservar toda la precisión.
      const updateData: Prisma.PricingRuleUncheckedUpdateInput = {
        ...otherFields,

        ...(costoA !== undefined ? { costoA: new Prisma.Decimal(costoA) } : {}),

        ...(costoB !== undefined ? { costoB: new Prisma.Decimal(costoB) } : {}),

        ...(costoC !== undefined ? { costoC: new Prisma.Decimal(costoC) } : {}),
      };

      const updated = await this.prisma.pricingRule.update({
        where: { id },
        data: updateData,
      });

      const afterFull = await this.findOneOrThrow(id);

      // comentario en español: registrar únicamente los campos enviados.
      const changedFields = Object.keys(dto ?? {}).filter(
        (key) => (dto as Record<string, unknown>)[key] !== undefined,
      );

      await this.logs.log({
        action: "UPDATE",
        entityType: "PricingRule",
        entityId: id,
        userId: actor.id,
        message: `PricingRule updated (#${id})`,
        before: this.toSnapshot(beforeFull),
        after: this.toSnapshot(afterFull),
        meta: {
          source: "PricingRulesService.update",
          actorUserId: actor.id,
          actorRole: getRoleName(actor) ?? null,
          changedFields,
        },
      });

      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "This update would create a duplicate pricing rule.",
        );
      }

      throw error;
    }
  }

  async remove(id: number, actor: AuthUser) {
    const beforeFull = await this.findOneOrThrow(id);

    const deleted = await this.prisma.pricingRule.delete({ where: { id } });

    await this.logs.log({
      action: "DELETE",
      entityType: "PricingRule",
      entityId: id,
      userId: actor.id,
      message: `PricingRule deleted (#${id})`,
      before: this.toSnapshot(beforeFull),
      meta: {
        source: "PricingRulesService.remove",
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
      },
    });

    return deleted;
  }
}

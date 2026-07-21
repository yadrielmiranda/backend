import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PricingMode, Prisma, PrismaClient, ProductKind } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { LogsService } from "@/logs/logs.service";
import type { AuthUser } from "@/auth/types/auth-user.type";
import { getRoleName } from "@/auth/utils/get-role-name";

import { CreatePricingRangeDto } from "./dto/create-pricing-range.dto";
import { FindPricingRangesQueryDto } from "./dto/find-pricing-ranges-query.dto";
import { AvailablePricingRangeCrystalsQueryDto } from "./dto/available-pricing-range-crystals-query.dto";
import { UpdatePricingRangeDto } from "./dto/update-pricing-range.dto";
import { UpsertPricingRangeRuleDto } from "./dto/upsert-pricing-range-rule.dto";

type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type DbClient = PrismaService | PrismaTransactionClient;

type NormalizedRule = {
  idCrystal: number;
  costoA: Prisma.Decimal;
  costoB: Prisma.Decimal;
  costoC: Prisma.Decimal;
};

@Injectable()
export class PricingRangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogsService,
  ) { }

  private async validateTarget(
    idSystem: number,
    idConfig: number,
    db: DbClient = this.prisma,
  ) {
    const [system, sysConf] = await Promise.all([
      db.system.findUnique({
        where: { id: idSystem },
        select: {
          id: true,
          brandProduct: {
            select: {
              product: {
                select: {
                  kind: true,
                  pricingMode: true,
                },
              },
            },
          },
        },
      }),

      db.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem,
            idConfig,
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

    const product = system.brandProduct.product;

    if (
      product.kind !== ProductKind.GLAZED_UNIT ||
      product.pricingMode !== PricingMode.AREA_PERIMETER
    ) {
      throw new BadRequestException(
        "Pricing ranges are only available for glazed products that use area/perimeter pricing.",
      );
    }

    if (!sysConf) {
      throw new BadRequestException(
        "The selected configuration is not associated with the selected system.",
      );
    }

    if (sysConf.pricingComponents.length > 0) {
      throw new BadRequestException(
        "Component-priced configurations cannot have direct pricing ranges.",
      );
    }
  }

  async findAvailableCrystals(
    query: AvailablePricingRangeCrystalsQueryDto,
  ) {
    await this.validateTarget(query.idSystem, query.idConfig);

    const systemCrystals = await this.prisma.systemCrystal.findMany({
      where: {
        idSystem: query.idSystem,
        crystal: {
          is: {
            isActive: true,
          },
        },
      },
      select: {
        sortOrder: true,
        crystal: {
          select: {
            id: true,
            glass: true,
            isActive: true,
          },
        },
      },
    });

    return systemCrystals
      .sort((a, b) => {
        const orderDifference = a.sortOrder - b.sortOrder;

        if (orderDifference !== 0) {
          return orderDifference;
        }

        return a.crystal.glass.localeCompare(b.crystal.glass);
      })
      .map((item) => item.crystal);
  }

  private parseDimension(
    value: string | Prisma.Decimal | null | undefined,
    label: string,
  ): Prisma.Decimal | null {
    if (value == null || value === "") {
      return null;
    }

    const dimension = new Prisma.Decimal(String(value));

    if (!dimension.isFinite() || dimension.lte(0)) {
      throw new BadRequestException(`${label} must be greater than zero.`);
    }

    return dimension;
  }

  private validateBounds(data: {
    minWidthIn?: string | Prisma.Decimal | null;
    minWidthInclusive?: boolean;
    maxWidthIn?: string | Prisma.Decimal | null;
    maxWidthInclusive?: boolean;
    minHeightIn?: string | Prisma.Decimal | null;
    minHeightInclusive?: boolean;
    maxHeightIn?: string | Prisma.Decimal | null;
    maxHeightInclusive?: boolean;
  }) {
    const minWidthIn = this.parseDimension(data.minWidthIn, "Minimum width");

    const maxWidthIn = this.parseDimension(data.maxWidthIn, "Maximum width");

    const minHeightIn = this.parseDimension(data.minHeightIn, "Minimum height");

    const maxHeightIn = this.parseDimension(data.maxHeightIn, "Maximum height");

    if (
      minWidthIn == null &&
      maxWidthIn == null &&
      minHeightIn == null &&
      maxHeightIn == null
    ) {
      throw new BadRequestException(
        "A pricing range must define at least one width or height boundary.",
      );
    }

    const validateAxis = (
      minimum: Prisma.Decimal | null,
      maximum: Prisma.Decimal | null,
      minimumInclusive: boolean,
      maximumInclusive: boolean,
      label: string,
    ) => {
      if (minimum == null || maximum == null) {
        return;
      }

      if (minimum.gt(maximum)) {
        throw new BadRequestException(
          `Minimum ${label} cannot be greater than maximum ${label}.`,
        );
      }

      if (minimum.eq(maximum) && (!minimumInclusive || !maximumInclusive)) {
        throw new BadRequestException(
          `The ${label} range is empty because equal boundaries must both be inclusive.`,
        );
      }
    };

    validateAxis(
      minWidthIn,
      maxWidthIn,
      data.minWidthInclusive ?? true,
      data.maxWidthInclusive ?? true,
      "width",
    );

    validateAxis(
      minHeightIn,
      maxHeightIn,
      data.minHeightInclusive ?? true,
      data.maxHeightInclusive ?? true,
      "height",
    );

    return {
      minWidthIn,
      maxWidthIn,
      minHeightIn,
      maxHeightIn,
    };
  }

  private async findOneOrThrow(id: number, db: DbClient = this.prisma) {
    const range = await db.pricingRange.findUnique({
      where: { id },
      include: {
        rules: {
          include: {
            crystal: {
              select: {
                id: true,
                glass: true,
                isActive: true,
              },
            },
          },
          orderBy: {
            idCrystal: "asc",
          },
        },
      },
    });

    if (!range) {
      throw new NotFoundException(`Pricing Range with ID #${id} not found.`);
    }

    return range;
  }

  private toSnapshot(range: any) {
    return {
      id: range.id,
      idSystem: range.idSystem,
      idConfig: range.idConfig,
      code: range.code,

      minWidthIn: range.minWidthIn?.toString() ?? null,
      minWidthInclusive: range.minWidthInclusive,
      maxWidthIn: range.maxWidthIn?.toString() ?? null,
      maxWidthInclusive: range.maxWidthInclusive,

      minHeightIn: range.minHeightIn?.toString() ?? null,
      minHeightInclusive: range.minHeightInclusive,
      maxHeightIn: range.maxHeightIn?.toString() ?? null,
      maxHeightInclusive: range.maxHeightInclusive,

      sortOrder: range.sortOrder,
      isActive: range.isActive,

      rules: (range.rules ?? []).map((rule: any) => ({
        id: rule.id,
        idCrystal: rule.idCrystal,
        crystalName: rule.crystal?.glass ?? null,
        costoA: rule.costoA?.toString() ?? null,
        costoB: rule.costoB?.toString() ?? null,
        costoC: rule.costoC?.toString() ?? null,
      })),
    };
  }

  private async validateCrystalForSystem(
    idSystem: number,
    idCrystal: number,
    db: DbClient = this.prisma,
  ) {
    const systemCrystal = await db.systemCrystal.findUnique({
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

  private axisOverlaps(
    first: {
      min: Prisma.Decimal | null;
      minInclusive: boolean;
      max: Prisma.Decimal | null;
      maxInclusive: boolean;
    },
    second: {
      min: Prisma.Decimal | null;
      minInclusive: boolean;
      max: Prisma.Decimal | null;
      maxInclusive: boolean;
    },
  ) {
    if (first.max != null && second.min != null) {
      if (first.max.lt(second.min)) {
        return false;
      }

      if (
        first.max.eq(second.min) &&
        (!first.maxInclusive || !second.minInclusive)
      ) {
        return false;
      }
    }

    if (second.max != null && first.min != null) {
      if (second.max.lt(first.min)) {
        return false;
      }

      if (
        second.max.eq(first.min) &&
        (!second.maxInclusive || !first.minInclusive)
      ) {
        return false;
      }
    }

    return true;
  }

  private rangesOverlap(
    first: {
      minWidthIn: Prisma.Decimal | null;
      minWidthInclusive: boolean;
      maxWidthIn: Prisma.Decimal | null;
      maxWidthInclusive: boolean;
      minHeightIn: Prisma.Decimal | null;
      minHeightInclusive: boolean;
      maxHeightIn: Prisma.Decimal | null;
      maxHeightInclusive: boolean;
    },
    second: {
      minWidthIn: Prisma.Decimal | null;
      minWidthInclusive: boolean;
      maxWidthIn: Prisma.Decimal | null;
      maxWidthInclusive: boolean;
      minHeightIn: Prisma.Decimal | null;
      minHeightInclusive: boolean;
      maxHeightIn: Prisma.Decimal | null;
      maxHeightInclusive: boolean;
    },
  ) {
    const widthOverlaps = this.axisOverlaps(
      {
        min: first.minWidthIn,
        minInclusive: first.minWidthInclusive,
        max: first.maxWidthIn,
        maxInclusive: first.maxWidthInclusive,
      },
      {
        min: second.minWidthIn,
        minInclusive: second.minWidthInclusive,
        max: second.maxWidthIn,
        maxInclusive: second.maxWidthInclusive,
      },
    );

    if (!widthOverlaps) {
      return false;
    }

    return this.axisOverlaps(
      {
        min: first.minHeightIn,
        minInclusive: first.minHeightInclusive,
        max: first.maxHeightIn,
        maxInclusive: first.maxHeightInclusive,
      },
      {
        min: second.minHeightIn,
        minInclusive: second.minHeightInclusive,
        max: second.maxHeightIn,
        maxInclusive: second.maxHeightInclusive,
      },
    );
  }

  private async ensureNoOverlapForCrystal(
    range: {
      id: number;
      idSystem: number;
      idConfig: number;
      code: string;
      isActive: boolean;
      minWidthIn: Prisma.Decimal | null;
      minWidthInclusive: boolean;
      maxWidthIn: Prisma.Decimal | null;
      maxWidthInclusive: boolean;
      minHeightIn: Prisma.Decimal | null;
      minHeightInclusive: boolean;
      maxHeightIn: Prisma.Decimal | null;
      maxHeightInclusive: boolean;
    },
    idCrystal: number,
    db: DbClient = this.prisma,
  ) {
    if (!range.isActive) {
      return;
    }

    const otherRanges = await db.pricingRange.findMany({
      where: {
        idSystem: range.idSystem,
        idConfig: range.idConfig,
        id: {
          not: range.id,
        },
        isActive: true,
        rules: {
          some: {
            idCrystal,
          },
        },
      },
    });

    const overlappingRange = otherRanges.find((candidate) =>
      this.rangesOverlap(range, candidate),
    );

    if (overlappingRange) {
      throw new ConflictException(
        `Pricing range "${range.code}" overlaps with range "${overlappingRange.code}" for the selected crystal.`,
      );
    }
  }

  private parseCoefficient(value: string, label: string) {
    const coefficient = new Prisma.Decimal(value);

    if (!coefficient.isFinite()) {
      throw new BadRequestException(`${label} must be a finite number.`);
    }

    return coefficient;
  }

  private normalizeRules(rules: UpsertPricingRangeRuleDto[]): NormalizedRule[] {
    if (rules.length === 0) {
      throw new BadRequestException(
        "A pricing range must contain at least one crystal rule.",
      );
    }

    const crystalIds = rules.map((rule) => rule.idCrystal);

    if (new Set(crystalIds).size !== crystalIds.length) {
      throw new BadRequestException(
        "Crystal rules cannot be duplicated within a pricing range.",
      );
    }

    return rules.map((rule) => ({
      idCrystal: rule.idCrystal,
      costoA: this.parseCoefficient(rule.costoA, "Area Cost"),
      costoB: this.parseCoefficient(rule.costoB, "Perimeter Cost"),
      costoC: this.parseCoefficient(rule.costoC, "Fixed Cost"),
    }));
  }

  private async ensureNoDirectRuleForCrystal(
    idSystem: number,
    idConfig: number,
    idCrystal: number,
    db: DbClient = this.prisma,
  ) {
    const directRule = await db.pricingRule.findFirst({
      where: {
        idSystem,
        idConfig,
        idCrystal,
      },
      select: {
        id: true,
      },
    });

    if (directRule) {
      throw new BadRequestException(
        "Remove the direct pricing rule for this crystal before assigning range pricing.",
      );
    }
  }

  private async validateRulesForRange(
    range: {
      id: number;
      idSystem: number;
      idConfig: number;
      code: string;
      isActive: boolean;
      minWidthIn: Prisma.Decimal | null;
      minWidthInclusive: boolean;
      maxWidthIn: Prisma.Decimal | null;
      maxWidthInclusive: boolean;
      minHeightIn: Prisma.Decimal | null;
      minHeightInclusive: boolean;
      maxHeightIn: Prisma.Decimal | null;
      maxHeightInclusive: boolean;
    },
    rules: NormalizedRule[],
    db: DbClient,
  ) {
    for (const rule of rules) {
      await this.validateCrystalForSystem(range.idSystem, rule.idCrystal, db);

      await this.ensureNoDirectRuleForCrystal(
        range.idSystem,
        range.idConfig,
        rule.idCrystal,
        db,
      );

      await this.ensureNoOverlapForCrystal(range, rule.idCrystal, db);
    }
  }

  private async syncRules(
    rangeId: number,
    rules: NormalizedRule[],
    db: PrismaTransactionClient,
  ) {
    const crystalIds = rules.map((rule) => rule.idCrystal);

    await db.pricingRangeRule.deleteMany({
      where: {
        rangeId,
        idCrystal: {
          notIn: crystalIds,
        },
      },
    });

    for (const rule of rules) {
      await db.pricingRangeRule.upsert({
        where: {
          rangeId_idCrystal: {
            rangeId,
            idCrystal: rule.idCrystal,
          },
        },
        create: {
          rangeId,
          ...rule,
        },
        update: {
          costoA: rule.costoA,
          costoB: rule.costoB,
          costoC: rule.costoC,
        },
      });
    }
  }

  private toRuleSnapshot(rule: any) {
    return {
      id: rule.id,
      rangeId: rule.rangeId,
      idCrystal: rule.idCrystal,
      crystalName: rule.crystal?.glass ?? null,
      costoA: rule.costoA?.toString() ?? null,
      costoB: rule.costoB?.toString() ?? null,
      costoC: rule.costoC?.toString() ?? null,
    };
  }

  async upsertRule(
    rangeId: number,
    dto: UpsertPricingRangeRuleDto,
    actor: AuthUser,
  ) {
    const normalizedRule = this.normalizeRules([dto])[0];

    const result = await this.prisma.$transaction(async (tx) => {
      const range = await this.findOneOrThrow(rangeId, tx);

      await this.validateTarget(range.idSystem, range.idConfig, tx);

      await this.validateRulesForRange(range, [normalizedRule], tx);

      const existing = await tx.pricingRangeRule.findUnique({
        where: {
          rangeId_idCrystal: {
            rangeId,
            idCrystal: dto.idCrystal,
          },
        },
        include: {
          crystal: {
            select: {
              glass: true,
            },
          },
        },
      });

      const saved = await tx.pricingRangeRule.upsert({
        where: {
          rangeId_idCrystal: {
            rangeId,
            idCrystal: dto.idCrystal,
          },
        },
        create: {
          rangeId,
          ...normalizedRule,
        },
        update: {
          costoA: normalizedRule.costoA,
          costoB: normalizedRule.costoB,
          costoC: normalizedRule.costoC,
        },
      });

      const savedFull = await tx.pricingRangeRule.findUnique({
        where: {
          id: saved.id,
        },
        include: {
          crystal: {
            select: {
              glass: true,
            },
          },
        },
      });

      return {
        range,
        existing,
        saved,
        savedFull,
      };
    });

    const { range, existing, saved, savedFull } = result;

    await this.logs.log({
      action: existing ? "UPDATE" : "CREATE",
      entityType: "PricingRangeRule",
      entityId: saved.id,
      userId: actor.id,
      message: existing
        ? `PricingRangeRule updated (#${saved.id})`
        : `PricingRangeRule created (#${saved.id})`,
      ...(existing
        ? {
          before: this.toRuleSnapshot(existing),
        }
        : {}),
      after: this.toRuleSnapshot(savedFull ?? saved),
      meta: {
        source: "PricingRangesService.upsertRule",
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        rangeId,
        rangeCode: range.code,
      },
    });

    return savedFull ?? saved;
  }

  async removeRule(rangeId: number, idCrystal: number, actor: AuthUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const range = await this.findOneOrThrow(rangeId, tx);

      const existing = await tx.pricingRangeRule.findUnique({
        where: {
          rangeId_idCrystal: {
            rangeId,
            idCrystal,
          },
        },
        include: {
          crystal: {
            select: {
              glass: true,
            },
          },
        },
      });

      if (!existing) {
        throw new NotFoundException(
          "The selected crystal coefficient does not exist for this pricing range.",
        );
      }

      if (range.rules.length <= 1) {
        throw new BadRequestException(
          "A pricing range must contain at least one crystal rule.",
        );
      }

      await tx.pricingRangeRule.delete({
        where: {
          id: existing.id,
        },
      });

      return {
        range,
        existing,
      };
    });

    const { range, existing } = result;

    await this.logs.log({
      action: "DELETE",
      entityType: "PricingRangeRule",
      entityId: existing.id,
      userId: actor.id,
      message: `PricingRangeRule deleted (#${existing.id})`,
      before: this.toRuleSnapshot(existing),
      meta: {
        source: "PricingRangesService.removeRule",
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        rangeId,
        rangeCode: range.code,
      },
    });

    return {
      success: true,
    };
  }

  async findAll(query: FindPricingRangesQueryDto = {}) {
    return this.prisma.pricingRange.findMany({
      where: {
        ...(query.idSystem !== undefined ? { idSystem: query.idSystem } : {}),
        ...(query.idConfig !== undefined ? { idConfig: query.idConfig } : {}),
      },
      include: {
        rules: {
          include: {
            crystal: {
              select: {
                id: true,
                glass: true,
                isActive: true,
              },
            },
          },
          orderBy: {
            idCrystal: "asc",
          },
        },
      },
      orderBy: [
        { idSystem: "asc" },
        { idConfig: "asc" },
        { sortOrder: "asc" },
        { id: "asc" },
      ],
    });
  }

  async findOne(id: number) {
    return this.findOneOrThrow(id);
  }

  async create(dto: CreatePricingRangeDto, actor: AuthUser) {
    const bounds = this.validateBounds(dto);
    const rules = this.normalizeRules(dto.rules);

    try {
      const createdFull = await this.prisma.$transaction(async (tx) => {
        await this.validateTarget(dto.idSystem, dto.idConfig, tx);

        const created = await tx.pricingRange.create({
          data: {
            idSystem: dto.idSystem,
            idConfig: dto.idConfig,
            code: dto.code.trim().toUpperCase(),

            minWidthIn: bounds.minWidthIn,
            minWidthInclusive: dto.minWidthInclusive ?? true,

            maxWidthIn: bounds.maxWidthIn,
            maxWidthInclusive: dto.maxWidthInclusive ?? true,

            minHeightIn: bounds.minHeightIn,
            minHeightInclusive: dto.minHeightInclusive ?? true,

            maxHeightIn: bounds.maxHeightIn,
            maxHeightInclusive: dto.maxHeightInclusive ?? true,

            sortOrder: dto.sortOrder ?? 0,
            isActive: dto.isActive ?? true,
          },
        });

        const proposedRange = {
          ...created,
          minWidthIn: bounds.minWidthIn,
          maxWidthIn: bounds.maxWidthIn,
          minHeightIn: bounds.minHeightIn,
          maxHeightIn: bounds.maxHeightIn,
        };

        await this.validateRulesForRange(proposedRange, rules, tx);

        await this.syncRules(created.id, rules, tx);

        return this.findOneOrThrow(created.id, tx);
      });

      await this.logs.log({
        action: "CREATE",
        entityType: "PricingRange",
        entityId: createdFull.id,
        userId: actor.id,
        message: `PricingRange created (#${createdFull.id})`,
        after: this.toSnapshot(createdFull),
        meta: {
          source: "PricingRangesService.create",
          actorUserId: actor.id,
          actorRole: getRoleName(actor) ?? null,
        },
      });

      return createdFull;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A pricing range with this code already exists for the selected system and configuration.",
        );
      }

      throw error;
    }
  }

  async update(id: number, dto: UpdatePricingRangeDto, actor: AuthUser) {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const before = await this.findOneOrThrow(id, tx);

        await this.validateTarget(before.idSystem, before.idConfig, tx);

        const bounds = this.validateBounds({
          minWidthIn:
            dto.minWidthIn !== undefined ? dto.minWidthIn : before.minWidthIn,
          minWidthInclusive: dto.minWidthInclusive ?? before.minWidthInclusive,
          maxWidthIn:
            dto.maxWidthIn !== undefined ? dto.maxWidthIn : before.maxWidthIn,
          maxWidthInclusive: dto.maxWidthInclusive ?? before.maxWidthInclusive,
          minHeightIn:
            dto.minHeightIn !== undefined
              ? dto.minHeightIn
              : before.minHeightIn,
          minHeightInclusive:
            dto.minHeightInclusive ?? before.minHeightInclusive,
          maxHeightIn:
            dto.maxHeightIn !== undefined
              ? dto.maxHeightIn
              : before.maxHeightIn,
          maxHeightInclusive:
            dto.maxHeightInclusive ?? before.maxHeightInclusive,
        });

        const rules =
          dto.rules !== undefined
            ? this.normalizeRules(dto.rules)
            : before.rules.map((rule) => ({
              idCrystal: rule.idCrystal,
              costoA: rule.costoA,
              costoB: rule.costoB,
              costoC: rule.costoC,
            }));

        if (rules.length === 0) {
          throw new BadRequestException(
            "A pricing range must contain at least one crystal rule.",
          );
        }

        const proposedRange = {
          id: before.id,
          idSystem: before.idSystem,
          idConfig: before.idConfig,
          code:
            dto.code !== undefined
              ? dto.code.trim().toUpperCase()
              : before.code,
          isActive: dto.isActive ?? before.isActive,
          minWidthIn: bounds.minWidthIn,
          minWidthInclusive: dto.minWidthInclusive ?? before.minWidthInclusive,
          maxWidthIn: bounds.maxWidthIn,
          maxWidthInclusive: dto.maxWidthInclusive ?? before.maxWidthInclusive,
          minHeightIn: bounds.minHeightIn,
          minHeightInclusive:
            dto.minHeightInclusive ?? before.minHeightInclusive,
          maxHeightIn: bounds.maxHeightIn,
          maxHeightInclusive:
            dto.maxHeightInclusive ?? before.maxHeightInclusive,
        };

        await this.validateRulesForRange(proposedRange, rules, tx);

        const updated = await tx.pricingRange.update({
          where: { id },
          data: {
            ...(dto.code !== undefined
              ? {
                code: dto.code.trim().toUpperCase(),
              }
              : {}),

            ...(dto.minWidthIn !== undefined
              ? { minWidthIn: bounds.minWidthIn }
              : {}),

            ...(dto.minWidthInclusive !== undefined
              ? {
                minWidthInclusive: dto.minWidthInclusive,
              }
              : {}),

            ...(dto.maxWidthIn !== undefined
              ? { maxWidthIn: bounds.maxWidthIn }
              : {}),

            ...(dto.maxWidthInclusive !== undefined
              ? {
                maxWidthInclusive: dto.maxWidthInclusive,
              }
              : {}),

            ...(dto.minHeightIn !== undefined
              ? {
                minHeightIn: bounds.minHeightIn,
              }
              : {}),

            ...(dto.minHeightInclusive !== undefined
              ? {
                minHeightInclusive: dto.minHeightInclusive,
              }
              : {}),

            ...(dto.maxHeightIn !== undefined
              ? {
                maxHeightIn: bounds.maxHeightIn,
              }
              : {}),

            ...(dto.maxHeightInclusive !== undefined
              ? {
                maxHeightInclusive: dto.maxHeightInclusive,
              }
              : {}),

            ...(dto.sortOrder !== undefined
              ? { sortOrder: dto.sortOrder }
              : {}),

            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });

        if (dto.rules !== undefined) {
          await this.syncRules(id, rules, tx);
        }

        const after = await this.findOneOrThrow(updated.id, tx);

        return {
          before,
          after,
        };
      });

      const { before, after } = result;

      const changedFields = Object.keys(dto).filter(
        (key) => (dto as Record<string, unknown>)[key] !== undefined,
      );

      await this.logs.log({
        action: "UPDATE",
        entityType: "PricingRange",
        entityId: id,
        userId: actor.id,
        message: `PricingRange updated (#${id})`,
        before: this.toSnapshot(before),
        after: this.toSnapshot(after),
        meta: {
          source: "PricingRangesService.update",
          actorUserId: actor.id,
          actorRole: getRoleName(actor) ?? null,
          changedFields,
        },
      });

      return after;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A pricing range with this code already exists for the selected system and configuration.",
        );
      }

      throw error;
    }
  }

  async remove(id: number, actor: AuthUser) {
    const before = await this.findOneOrThrow(id);

    await this.prisma.pricingRange.delete({
      where: { id },
    });

    await this.logs.log({
      action: "DELETE",
      entityType: "PricingRange",
      entityId: id,
      userId: actor.id,
      message: `PricingRange deleted (#${id})`,
      before: this.toSnapshot(before),
      meta: {
        source: "PricingRangesService.remove",
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        deletedRuleCount: before.rules.length,
      },
    });

    return {
      success: true,
    };
  }
}

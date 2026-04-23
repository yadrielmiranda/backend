import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto';
import { Prisma } from '@prisma/client';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';

@Injectable()
export class PricingRulesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) {}

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

    if (!rule) throw new NotFoundException(`Pricing Rule with ID #${id} not found.`);
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

      // campos típicos de pricing rule (por si existen)
      A: rule.A ?? null,
      B: rule.B ?? null,
      C: rule.C ?? null,
      minPrice: rule.minPrice ?? null,

      // nombres (solo si vienen incluidos)
      brandName: rule.brand?.name ?? null,
      productName: rule.product?.name ?? null,
      systemName: rule.system?.name ?? null,
      configName: rule.config?.conf ?? null,
      crystalName: rule.crystal?.glass ?? null,
    };
  }

  async create(dto: CreatePricingRuleDto, actor: AuthUser) {
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
        'A pricing rule for this exact combination already exists.',
      );
    }

    const created = await this.prisma.pricingRule.create({
      data: dto,
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
      action: 'CREATE',
      entityType: 'PricingRule',
      entityId: created.id,
      userId: actor.id,
      message: `PricingRule created (#${created.id})`,
      after: this.toSnapshot(createdFull ?? created),
      meta: {
        source: 'PricingRulesService.create',
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
      orderBy: { id: 'asc' },
    });
  }

  async findOne(id: number) {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException(`Pricing Rule with ID #${id} not found.`);
    return rule;
  }

  async update(id: number, dto: UpdatePricingRuleDto, actor: AuthUser) {
    const beforeFull = await this.findOneOrThrow(id);

    try {
      const updated = await this.prisma.pricingRule.update({
        where: { id },
        data: dto,
      });

      const afterFull = await this.findOneOrThrow(id);

      // comentario en espanol: changedFields básico (solo keys que vengan en el dto)
      const changedFields = Object.keys(dto ?? {}).filter((k) => (dto as any)[k] !== undefined);

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'PricingRule',
        entityId: id,
        userId: actor.id,
        message: `PricingRule updated (#${id})`,
        before: this.toSnapshot(beforeFull),
        after: this.toSnapshot(afterFull),
        meta: {
          source: 'PricingRulesService.update',
          actorUserId: actor.id,
          actorRole: getRoleName(actor) ?? null,
          changedFields,
        },
      });

      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('This update would create a duplicate pricing rule.');
      }
      throw error;
    }
  }

  async remove(id: number, actor: AuthUser) {
    const beforeFull = await this.findOneOrThrow(id);

    const deleted = await this.prisma.pricingRule.delete({ where: { id } });

    await this.logs.log({
      action: 'DELETE',
      entityType: 'PricingRule',
      entityId: id,
      userId: actor.id,
      message: `PricingRule deleted (#${id})`,
      before: this.toSnapshot(beforeFull),
      meta: {
        source: 'PricingRulesService.remove',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
      },
    });

    return deleted;
  }
}

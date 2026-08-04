import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InstallationRuleMetric,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import {
  AddBulkSysConfInstallationServiceDto,
  CreateInstallationServiceDto,
  InstallationServiceRuleDto,
  SetSysConfInstallationServicesDto,
  UpdateInstallationServiceDto,
} from './dto/installation-catalog.dto';
import {
  CreateInstallationPriceProfileDto,
  UpdateInstallationPriceProfileDto,
} from './dto/installation-profile.dto';

const serviceInclude = {
  rules: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
  _count: {
    select: {
      sysConfs: true,
      lines: true,
    },
  },
} satisfies Prisma.InstallationServiceInclude;

@Injectable()
export class InstallationCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogsService,
  ) {}

  private normalizedName(name: string): string {
    const result = String(name ?? '').trim();
    if (!result) throw new BadRequestException('Service name is required.');
    return result;
  }

  private decimal(value: number | string, label: string): Prisma.Decimal {
    try {
      const result = new Decimal(String(value));
      if (!result.isFinite()) throw new Error();
      return new Prisma.Decimal(result.toString());
    } catch {
      throw new BadRequestException(`${label} must be a valid number.`);
    }
  }

  private validateRules(
    metric: InstallationRuleMetric,
    rules: InstallationServiceRuleDto[],
  ): void {
    const activeRules = rules
      .filter((rule) => rule.isActive !== false)
      .map((rule, index) => ({
        ...rule,
        index,
        min:
          rule.minValue === null || rule.minValue === undefined
            ? null
            : new Decimal(String(rule.minValue)),
        max:
          rule.maxValue === null || rule.maxValue === undefined
            ? null
            : new Decimal(String(rule.maxValue)),
        minInclusive: rule.minInclusive !== false,
        maxInclusive: rule.maxInclusive === true,
      }));

    if (metric === InstallationRuleMetric.NONE) {
      if (activeRules.length > 0) {
        throw new BadRequestException(
          'A service with rule metric NONE must use base rate and cannot have active range rules.',
        );
      }
      return;
    }

    if (activeRules.length === 0) return;

    for (const rule of activeRules) {
      if (rule.min && !rule.min.isFinite()) {
        throw new BadRequestException(`Rule ${rule.index + 1} has an invalid minimum.`);
      }
      if (rule.max && !rule.max.isFinite()) {
        throw new BadRequestException(`Rule ${rule.index + 1} has an invalid maximum.`);
      }
      if (rule.min && rule.max && rule.min.gte(rule.max)) {
        throw new BadRequestException(
          `Rule ${rule.index + 1} minimum must be lower than its maximum.`,
        );
      }
      if (new Decimal(String(rule.rate)).lt(0)) {
        throw new BadRequestException(`Rule ${rule.index + 1} rate cannot be negative.`);
      }
    }

    const sorted = [...activeRules].sort((left, right) => {
      if (left.min === null) return right.min === null ? 0 : -1;
      if (right.min === null) return 1;
      return left.min.comparedTo(right.min);
    });

    if (sorted[0].min !== null || sorted[sorted.length - 1]?.max !== null) {
      throw new BadRequestException(
        'Active range rules must cover the complete metric: the first minimum and last maximum must be open.',
      );
    }

    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];

      if (previous.max === null || current.min === null) {
        throw new BadRequestException('Only the outer range limits can be open.');
      }

      if (!previous.max.eq(current.min)) {
        throw new BadRequestException(
          `There is a gap or overlap between rules ${previous.index + 1} and ${current.index + 1}.`,
        );
      }

      if (previous.maxInclusive === current.minInclusive) {
        throw new BadRequestException(
          `The shared boundary between rules ${previous.index + 1} and ${current.index + 1} must belong to exactly one rule.`,
        );
      }
    }
  }

  private ruleCreateData(rule: InstallationServiceRuleDto, index: number) {
    return {
      minValue:
        rule.minValue === null || rule.minValue === undefined
          ? null
          : this.decimal(rule.minValue, 'Rule minimum'),
      minInclusive: rule.minInclusive !== false,
      maxValue:
        rule.maxValue === null || rule.maxValue === undefined
          ? null
          : this.decimal(rule.maxValue, 'Rule maximum'),
      maxInclusive: rule.maxInclusive === true,
      rate: this.decimal(rule.rate, 'Rule rate'),
      sortOrder: rule.sortOrder ?? index,
      isActive: rule.isActive !== false,
    };
  }

  findServices(includeInactive = true) {
    return this.prisma.installationService.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: serviceInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findService(id: number) {
    const service = await this.prisma.installationService.findUnique({
      where: { id },
      include: serviceInclude,
    });
    if (!service) throw new NotFoundException(`Installation service #${id} not found.`);
    return service;
  }

  async createService(dto: CreateInstallationServiceDto, actor: AuthUser) {
    const rules = dto.rules ?? [];
    this.validateRules(dto.ruleMetric, rules);

    try {
      const created = await this.prisma.installationService.create({
        data: {
          name: this.normalizedName(dto.name),
          description: dto.description?.trim() || null,
          billingUnit: dto.billingUnit,
          ruleMetric: dto.ruleMetric,
          baseRate: this.decimal(dto.baseRate, 'Base rate'),
          minimumCharge: this.decimal(dto.minimumCharge ?? 0, 'Minimum charge'),
          availableForRequest: dto.availableForRequest ?? false,
          availableForField: dto.availableForField ?? true,
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
          rules: {
            create: rules.map((rule, index) => this.ruleCreateData(rule, index)),
          },
        },
        include: serviceInclude,
      });

      await this.logs.log({
        action: 'CREATE',
        entityType: 'InstallationService',
        entityId: created.id,
        userId: actor.id,
        message: `Installation service "${created.name}" created.`,
        after: created,
      });
      return created;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('An installation service with this name already exists.');
      }
      throw error;
    }
  }

  async updateService(
    id: number,
    dto: UpdateInstallationServiceDto,
    actor: AuthUser,
  ) {
    const before = await this.findService(id);
    const metric = dto.ruleMetric ?? before.ruleMetric;
    const rules = dto.rules ?? before.rules.map((rule) => ({
      minValue: rule.minValue == null ? null : Number(rule.minValue),
      minInclusive: rule.minInclusive,
      maxValue: rule.maxValue == null ? null : Number(rule.maxValue),
      maxInclusive: rule.maxInclusive,
      rate: Number(rule.rate),
      sortOrder: rule.sortOrder,
      isActive: rule.isActive,
    }));

    this.validateRules(metric, rules);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (dto.rules !== undefined) {
          await tx.installationServiceRule.deleteMany({ where: { serviceId: id } });
        }

        return tx.installationService.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: this.normalizedName(dto.name) } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
            ...(dto.billingUnit !== undefined ? { billingUnit: dto.billingUnit } : {}),
            ...(dto.ruleMetric !== undefined ? { ruleMetric: dto.ruleMetric } : {}),
            ...(dto.baseRate !== undefined
              ? { baseRate: this.decimal(dto.baseRate, 'Base rate') }
              : {}),
            ...(dto.minimumCharge !== undefined
              ? {
                  minimumCharge: this.decimal(
                    dto.minimumCharge,
                    'Minimum charge',
                  ),
                }
              : {}),
            ...(dto.availableForRequest !== undefined
              ? { availableForRequest: dto.availableForRequest }
              : {}),
            ...(dto.availableForField !== undefined
              ? { availableForField: dto.availableForField }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(dto.rules !== undefined
              ? {
                  rules: {
                    create: dto.rules.map((rule, index) =>
                      this.ruleCreateData(rule, index),
                    ),
                  },
                }
              : {}),
          },
          include: serviceInclude,
        });
      });

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'InstallationService',
        entityId: id,
        userId: actor.id,
        message: `Installation service "${updated.name}" updated.`,
        before,
        after: updated,
      });
      return updated;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('An installation service with this name already exists.');
      }
      throw error;
    }
  }

  async removeService(id: number, actor: AuthUser) {
    const service = await this.findService(id);

    if (service._count.lines > 0) {
      const deactivated = await this.prisma.installationService.update({
        where: { id },
        data: { isActive: false },
        include: serviceInclude,
      });
      await this.logs.log({
        action: 'UPDATE',
        entityType: 'InstallationService',
        entityId: id,
        userId: actor.id,
        message: `Installation service "${service.name}" deactivated because it has quote history.`,
        before: service,
        after: deactivated,
      });
      return deactivated;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sysConfInstallationService.deleteMany({ where: { serviceId: id } });
      await tx.installationService.delete({ where: { id } });
    });

    await this.logs.log({
      action: 'DELETE',
      entityType: 'InstallationService',
      entityId: id,
      userId: actor.id,
      message: `Installation service "${service.name}" deleted.`,
      before: service,
    });
    return { deleted: true, id };
  }

  async findDirectSysConfServiceMappings() {
    const sysConfs = await this.prisma.sysConf.findMany({
      where: {
        pricingComponents: { none: {} },
      },
      select: {
        idSystem: true,
        idConfig: true,
        system: {
          select: {
            idBrand: true,
            idProduct: true,
            name: true,
            isActive: true,
            brandProduct: {
              select: {
                brand: { select: { name: true } },
                product: { select: { name: true } },
              },
            },
          },
        },
        config: { select: { conf: true, isActive: true } },
        installationServices: {
          select: { serviceId: true },
          orderBy: [{ sortOrder: 'asc' }, { serviceId: 'asc' }],
        },
      },
    });

    return sysConfs
      .map((sysConf) => ({
        idSystem: sysConf.idSystem,
        idConfig: sysConf.idConfig,
        idBrand: sysConf.system.idBrand,
        idProduct: sysConf.system.idProduct,
        brandName: sysConf.system.brandProduct.brand.name,
        productName: sysConf.system.brandProduct.product.name,
        systemName: sysConf.system.name,
        configName: sysConf.config.conf,
        isActive: sysConf.system.isActive && sysConf.config.isActive,
        serviceIds: sysConf.installationServices.map(
          (mapping) => mapping.serviceId,
        ),
      }))
      .sort(
        (left, right) =>
          left.brandName.localeCompare(right.brandName) ||
          left.productName.localeCompare(right.productName) ||
          left.systemName.localeCompare(right.systemName) ||
          left.configName.localeCompare(right.configName),
      );
  }

  async getSysConfServices(idSystem: number, idConfig: number) {
    const sysConf = await this.prisma.sysConf.findUnique({
      where: { idSystem_idConfig: { idSystem, idConfig } },
      include: {
        system: { select: { id: true, name: true } },
        config: { select: { id: true, conf: true } },
        pricingComponents: { select: { componentType: true, sourceConfigId: true } },
        installationServices: {
          include: { service: { include: serviceInclude } },
          orderBy: [{ sortOrder: 'asc' }, { serviceId: 'asc' }],
        },
      },
    });
    if (!sysConf) throw new NotFoundException('System configuration not found.');
    return sysConf;
  }

  async setSysConfServices(
    idSystem: number,
    idConfig: number,
    dto: SetSysConfInstallationServicesDto,
    actor: AuthUser,
  ) {
    const sysConf = await this.prisma.sysConf.findUnique({
      where: { idSystem_idConfig: { idSystem, idConfig } },
      include: { pricingComponents: { select: { componentType: true } } },
    });
    if (!sysConf) throw new NotFoundException('System configuration not found.');
    if (sysConf.pricingComponents.length > 0) {
      throw new BadRequestException(
        'Installation services can only be associated with direct configurations. Composite configurations inherit their source services.',
      );
    }

    const serviceIds = dto.serviceIds ?? [];
    const existing = await this.prisma.installationService.findMany({
      where: { id: { in: serviceIds } },
      select: { id: true },
    });
    if (existing.length !== serviceIds.length) {
      throw new BadRequestException('One or more installation services do not exist.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sysConfInstallationService.deleteMany({
        where: { idSystem, idConfig },
      });
      if (serviceIds.length > 0) {
        await tx.sysConfInstallationService.createMany({
          data: serviceIds.map((serviceId, sortOrder) => ({
            idSystem,
            idConfig,
            serviceId,
            sortOrder,
          })),
        });
      }
    });

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'SysConfInstallationServices',
      entityId: idConfig,
      userId: actor.id,
      message: `Installation-service mappings updated for System #${idSystem}, Config #${idConfig}.`,
      after: { idSystem, idConfig, serviceIds },
    });
    return this.getSysConfServices(idSystem, idConfig);
  }

  private normalizeBulkTargets(dto: AddBulkSysConfInstallationServiceDto) {
    return Array.from(
      new Map(
        dto.targets.map((target) => [
          `${target.idSystem}:${target.idConfig}`,
          {
            idSystem: target.idSystem,
            idConfig: target.idConfig,
          },
        ]),
      ).values(),
    );
  }

  private async validateDirectBulkTargets(
    targets: Array<{ idSystem: number; idConfig: number }>,
  ): Promise<void> {
    const sysConfs = await this.prisma.sysConf.findMany({
      where: {
        OR: targets.map((target) => ({
          idSystem: target.idSystem,
          idConfig: target.idConfig,
        })),
      },
      select: {
        idSystem: true,
        idConfig: true,
        system: { select: { name: true } },
        config: { select: { conf: true } },
        pricingComponents: { select: { componentType: true } },
      },
    });

    const foundKeys = new Set(
      sysConfs.map((sysConf) => `${sysConf.idSystem}:${sysConf.idConfig}`),
    );
    const missingTargets = targets.filter(
      (target) => !foundKeys.has(`${target.idSystem}:${target.idConfig}`),
    );
    if (missingTargets.length > 0) {
      const sample = missingTargets
        .slice(0, 5)
        .map((target) => `#${target.idSystem}/#${target.idConfig}`)
        .join(', ');
      throw new BadRequestException(
        `One or more system configurations do not exist: ${sample}. No mappings were changed.`,
      );
    }

    const compositeTargets = sysConfs.filter(
      (sysConf) => sysConf.pricingComponents.length > 0,
    );
    if (compositeTargets.length > 0) {
      const sample = compositeTargets
        .slice(0, 5)
        .map(
          (sysConf) => `${sysConf.system.name} / ${sysConf.config.conf}`,
        )
        .join(', ');
      throw new BadRequestException(
        `Bulk mapping only supports direct configurations. Remove: ${sample}. No mappings were changed.`,
      );
    }
  }

  async addBulkSysConfServiceMappings(
    dto: AddBulkSysConfInstallationServiceDto,
    actor: AuthUser,
  ) {
    const targets = this.normalizeBulkTargets(dto);

    const service = await this.prisma.installationService.findFirst({
      where: {
        id: dto.serviceId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
      },
    });
    if (!service) {
      throw new BadRequestException(
        'The selected installation service does not exist or is inactive.',
      );
    }

    await this.validateDirectBulkTargets(targets);

    const result = await this.prisma.sysConfInstallationService.createMany({
      data: targets.map((target) => ({
        ...target,
        serviceId: service.id,
        sortOrder: 0,
      })),
      skipDuplicates: true,
    });

    const response = {
      serviceId: service.id,
      serviceName: service.name,
      selectedTargets: targets.length,
      createdMappings: result.count,
      alreadyMapped: targets.length - result.count,
    };

    await this.logs.log({
      action: 'CREATE',
      entityType: 'SysConfInstallationServicesBulk',
      entityId: service.id,
      userId: actor.id,
      message: `${result.count} bulk installation-service mappings created for "${service.name}".`,
      after: response,
    });

    return response;
  }

  async removeBulkSysConfServiceMappings(
    dto: AddBulkSysConfInstallationServiceDto,
    actor: AuthUser,
  ) {
    const targets = this.normalizeBulkTargets(dto);

    const service = await this.prisma.installationService.findUnique({
      where: { id: dto.serviceId },
      select: { id: true, name: true },
    });
    if (!service) {
      throw new BadRequestException(
        'The selected installation service does not exist.',
      );
    }

    await this.validateDirectBulkTargets(targets);

    const result = await this.prisma.$transaction((tx) =>
      tx.sysConfInstallationService.deleteMany({
        where: {
          serviceId: service.id,
          OR: targets.map((target) => ({
            idSystem: target.idSystem,
            idConfig: target.idConfig,
          })),
        },
      }),
    );

    const response = {
      serviceId: service.id,
      serviceName: service.name,
      selectedTargets: targets.length,
      removedMappings: result.count,
      notMapped: targets.length - result.count,
    };

    await this.logs.log({
      action: 'DELETE',
      entityType: 'SysConfInstallationServicesBulk',
      entityId: service.id,
      userId: actor.id,
      message: `${result.count} bulk installation-service mappings removed for "${service.name}".`,
      before: response,
    });

    return response;
  }

  findProfiles(includeInactive = true) {
    return this.prisma.installationPriceProfile.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: {
        _count: { select: { roles: true, users: true, quotes: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findProfile(id: number) {
    const profile = await this.prisma.installationPriceProfile.findUnique({
      where: { id },
      include: { _count: { select: { roles: true, users: true, quotes: true } } },
    });
    if (!profile) throw new NotFoundException(`Installation price profile #${id} not found.`);
    return profile;
  }

  async createProfile(dto: CreateInstallationPriceProfileDto, actor: AuthUser) {
    const defaultExists = await this.prisma.installationPriceProfile.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });
    const makeDefault = dto.isDefault === true || !defaultExists;

    try {
      const profile = await this.prisma.$transaction(async (tx) => {
        if (makeDefault) {
          await tx.installationPriceProfile.updateMany({ data: { isDefault: false } });
        }
        return tx.installationPriceProfile.create({
          data: {
            name: this.normalizedName(dto.name),
            adjustmentPercent: this.decimal(dto.adjustmentPercent, 'Adjustment percent'),
            minimumCharge: this.decimal(dto.minimumCharge, 'Minimum charge'),
            isDefault: makeDefault,
            isActive: makeDefault ? true : dto.isActive ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
          include: { _count: { select: { roles: true, users: true, quotes: true } } },
        });
      });
      await this.logs.log({
        action: 'CREATE',
        entityType: 'InstallationPriceProfile',
        entityId: profile.id,
        userId: actor.id,
        message: `Installation price profile "${profile.name}" created.`,
        after: profile,
      });
      return profile;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('An installation profile with this name already exists.');
      }
      throw error;
    }
  }

  async updateProfile(
    id: number,
    dto: UpdateInstallationPriceProfileDto,
    actor: AuthUser,
  ) {
    const before = await this.findProfile(id);
    if (before.isDefault && dto.isDefault === false) {
      throw new BadRequestException('Choose another default profile instead of removing the current default directly.');
    }
    if (before.isDefault && dto.isActive === false) {
      throw new BadRequestException('The default installation profile cannot be inactive.');
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault === true) {
          await tx.installationPriceProfile.updateMany({ data: { isDefault: false } });
        }
        return tx.installationPriceProfile.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: this.normalizedName(dto.name) } : {}),
            ...(dto.adjustmentPercent !== undefined
              ? { adjustmentPercent: this.decimal(dto.adjustmentPercent, 'Adjustment percent') }
              : {}),
            ...(dto.minimumCharge !== undefined
              ? { minimumCharge: this.decimal(dto.minimumCharge, 'Minimum charge') }
              : {}),
            ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
            ...(dto.isDefault === true
              ? { isActive: true }
              : dto.isActive !== undefined
                ? { isActive: dto.isActive }
                : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          },
          include: { _count: { select: { roles: true, users: true, quotes: true } } },
        });
      });
      await this.logs.log({
        action: 'UPDATE',
        entityType: 'InstallationPriceProfile',
        entityId: id,
        userId: actor.id,
        message: `Installation price profile "${updated.name}" updated.`,
        before,
        after: updated,
      });
      return updated;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('An installation profile with this name already exists.');
      }
      throw error;
    }
  }

  async removeProfile(id: number, actor: AuthUser) {
    const profile = await this.findProfile(id);
    if (profile.isDefault) {
      throw new BadRequestException('Assign another default installation profile before removing this one.');
    }

    if (profile._count.roles + profile._count.users + profile._count.quotes > 0) {
      const deactivated = await this.prisma.installationPriceProfile.update({
        where: { id },
        data: { isActive: false },
        include: { _count: { select: { roles: true, users: true, quotes: true } } },
      });
      return deactivated;
    }

    await this.prisma.installationPriceProfile.delete({ where: { id } });
    await this.logs.log({
      action: 'DELETE',
      entityType: 'InstallationPriceProfile',
      entityId: id,
      userId: actor.id,
      message: `Installation price profile "${profile.name}" deleted.`,
      before: profile,
    });
    return { deleted: true, id };
  }
}

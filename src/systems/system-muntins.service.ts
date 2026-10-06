import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { ApplySystemMuntinsDto, MuntinTargetDto, UpdateSystemMuntinRuleDto } from './dto/system-muntins.dto';

const ruleInclude = { allowedTypes: { select: { muntinTypeId: true } }, targets: true } as const;
type Selection = { availability: 'ALL' | 'SELECTED'; allowedTypeIds: number[] };

@Injectable()
export class SystemMuntinsService {
  constructor(private readonly prisma: PrismaService) {}

  async manage(systemId: number, client: Prisma.TransactionClient = this.prisma) {
    const system = await client.system.findUnique({
      where: { id: systemId },
      select: {
        id: true, name: true,
        sysconfs: { select: { config: { select: { id: true, conf: true } } }, orderBy: { sortOrder: 'asc' } },
        systemCrystals: { include: { crystal: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!system) throw new NotFoundException('System not found.');
    const [patterns, types, rules] = await Promise.all([
      client.muntinPattern.findMany({ orderBy: { name: 'asc' } }),
      client.muntinType.findMany({ orderBy: { name: 'asc' } }),
      client.systemMuntinRule.findMany({ where: { idSystem: systemId }, include: ruleInclude, orderBy: { id: 'asc' } }),
    ]);
    return {
      system: { id: system.id, name: system.name },
      configs: system.sysconfs.map(link => link.config),
      crystals: system.systemCrystals.map(link => link.crystal), patterns, types,
      rules: rules.map(rule => ({
        id: rule.id, patternId: rule.patternId, availability: rule.availability,
        allowedTypeIds: rule.allowedTypes.map(type => type.muntinTypeId).sort((a, b) => a - b),
        targets: rule.targets.map(target => ({ configId: target.idConfig, crystalId: target.idCrystal }))
          .sort((a, b) => a.configId - b.configId || a.crystalId - b.crystalId),
      })),
    };
  }

  private async mutate<T>(systemId: number, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          // Every compatibility writer locks the same parent before reading rules.
          const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM \`System\` WHERE id = ${systemId} FOR UPDATE`;
          if (!rows.length) throw new NotFoundException('System not found.');
          return operation(tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error: any) {
        if (error?.code !== 'P2034' || attempt >= 2) throw error;
      }
    }
  }

  private async validateTargets(tx: Prisma.TransactionClient, systemId: number, targets: MuntinTargetDto[], requireActive: boolean) {
    if (!Array.isArray(targets) || !targets.length || targets.some(target =>
      !target || !Number.isSafeInteger(target.configId) || target.configId < 1 ||
      !Number.isSafeInteger(target.crystalId) || target.crystalId < 1) ||
      new Set(targets.map(target => `${target.configId}:${target.crystalId}`)).size !== targets.length)
      throw new BadRequestException('Select unique configuration/crystal targets with positive integer IDs.');
    const configIds = [...new Set(targets.map(target => target.configId))];
    const crystalIds = [...new Set(targets.map(target => target.crystalId))];
    const [configs, crystals] = await Promise.all([
      tx.sysConf.findMany({ where: { idSystem: systemId, idConfig: { in: configIds } }, select: { idConfig: true } }),
      tx.systemCrystal.findMany({ where: { idSystem: systemId, idCrystal: { in: crystalIds } }, include: { crystal: true } }),
    ]);
    if (configs.length !== configIds.length || crystals.length !== crystalIds.length)
      throw new BadRequestException('Every configuration and crystal must be associated with this series.');
    if (requireActive && crystals.some(link => !link.crystal.isActive))
      throw new BadRequestException('Muntin permissions can only be assigned to active crystals.');
  }

  private async selection(tx: Prisma.TransactionClient, pattern: { inputMode: string; requiresType: boolean; isActive: boolean }, data: UpdateSystemMuntinRuleDto): Promise<Selection> {
    if (!pattern.isActive) throw new BadRequestException('Select an active muntin pattern.');
    if (pattern.inputMode === 'NONE') throw new BadRequestException('Full View is always available and does not need a rule.');
    const ids = data.allowedTypeIds ?? [];
    if (!['ALL', 'SELECTED'].includes(data.availability) || !Array.isArray(ids) ||
      ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)
      throw new BadRequestException('Invalid muntin availability or allowed type IDs.');
    if (!pattern.requiresType && (data.availability !== 'ALL' || ids.length))
      throw new BadRequestException('This pattern does not use a muntin type. Use ALL without type IDs.');
    if (data.availability === 'ALL' && ids.length)
      throw new BadRequestException('ALL availability must not contain selected type IDs.');
    if (data.availability === 'SELECTED' && !ids.length)
      throw new BadRequestException('Select at least one allowed muntin type.');
    if (ids.length) {
      const types = await tx.muntinType.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
      if (types.length !== ids.length) throw new BadRequestException('One or more allowed muntin types are invalid or inactive.');
    }
    return { availability: data.availability, allowedTypeIds: [...ids].sort((a, b) => a - b) };
  }

  private async matchingRule(tx: Prisma.TransactionClient, systemId: number, patternId: number, selection: Selection, excludeId?: number) {
    const candidates = await tx.systemMuntinRule.findMany({
      where: { idSystem: systemId, patternId, availability: selection.availability, ...(excludeId ? { id: { not: excludeId } } : {}) },
      include: { allowedTypes: { select: { muntinTypeId: true } } }, orderBy: { id: 'asc' },
    });
    return candidates.find(rule => {
      const ids = rule.allowedTypes.map(type => type.muntinTypeId).sort((a, b) => a - b);
      return ids.length === selection.allowedTypeIds.length && ids.every((id, index) => id === selection.allowedTypeIds[index]);
    });
  }

  async apply(systemId: number, data: ApplySystemMuntinsDto) {
    return this.mutate(systemId, async tx => {
      const pattern = await tx.muntinPattern.findUnique({ where: { id: data.patternId } });
      if (!pattern) throw new BadRequestException('Muntin pattern not found.');
      if (pattern.inputMode === 'NONE') throw new BadRequestException('Full View is always available and does not need a rule.');
      await this.validateTargets(tx, systemId, data.targets, data.availability !== 'NONE');
      if (data.availability === 'NONE') {
        if (data.allowedTypeIds != null && (!Array.isArray(data.allowedTypeIds) || data.allowedTypeIds.length))
          throw new BadRequestException('NONE availability must not contain selected type IDs.');
        await tx.systemMuntinAssignment.deleteMany({ where: {
          idSystem: systemId, patternId: data.patternId,
          OR: data.targets.map(target => ({ idConfig: target.configId, idCrystal: target.crystalId })),
        } });
      } else {
        const selection = await this.selection(tx, pattern, data as UpdateSystemMuntinRuleDto);
        const rule = await this.matchingRule(tx, systemId, pattern.id, selection) ??
          await tx.systemMuntinRule.create({ data: {
            idSystem: systemId, patternId: pattern.id, availability: selection.availability,
            allowedTypes: { create: selection.allowedTypeIds.map(muntinTypeId => ({ muntinTypeId })) },
          } });
        // Replace only the addressed tuples in two batched statements. The lock
        // and transaction prevent overlapping editors or partial reassignment.
        await tx.systemMuntinAssignment.deleteMany({ where: {
          idSystem: systemId, patternId: pattern.id,
          OR: data.targets.map(target => ({ idConfig: target.configId, idCrystal: target.crystalId })),
        } });
        await tx.systemMuntinAssignment.createMany({ data: data.targets.map(target => ({
          idSystem: systemId, idConfig: target.configId, idCrystal: target.crystalId,
          patternId: pattern.id, ruleId: rule.id,
        })) });
      }
      await tx.systemMuntinRule.deleteMany({ where: { idSystem: systemId, targets: { none: {} } } });
      return this.manage(systemId, tx);
    });
  }

  async updateRule(systemId: number, ruleId: number, data: UpdateSystemMuntinRuleDto) {
    return this.mutate(systemId, async tx => {
      const rule = await tx.systemMuntinRule.findFirst({ where: { id: ruleId, idSystem: systemId }, include: { pattern: true } });
      if (!rule) throw new NotFoundException('Muntin rule not found for this series.');
      const selection = await this.selection(tx, rule.pattern, data);
      const matching = await this.matchingRule(tx, systemId, rule.patternId, selection, ruleId);
      if (matching) {
        await tx.systemMuntinAssignment.updateMany({ where: { idSystem: systemId, ruleId }, data: { ruleId: matching.id } });
        await tx.systemMuntinRule.delete({ where: { id: ruleId } });
      } else {
        await tx.systemMuntinRule.update({ where: { id: ruleId }, data: {
          availability: selection.availability,
          allowedTypes: { deleteMany: {}, create: selection.allowedTypeIds.map(muntinTypeId => ({ muntinTypeId })) },
        } });
      }
      return this.manage(systemId, tx);
    });
  }

  async removeRule(systemId: number, ruleId: number) {
    return this.mutate(systemId, async tx => {
      const deleted = await tx.systemMuntinRule.deleteMany({ where: { id: ruleId, idSystem: systemId } });
      if (!deleted.count) throw new NotFoundException('Muntin rule not found for this series.');
      return this.manage(systemId, tx);
    });
  }
}

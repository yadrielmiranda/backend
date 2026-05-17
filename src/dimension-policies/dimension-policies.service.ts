// @/dimension-policies/dimension-policies.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { DimensionRuleType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { LogsService } from '@/logs/logs.service';

import { BulkUpsertRulesDto, RuleRowDto } from './dto/rule.dto';
import {
  CreatePolicyDto,
  DimensionRounding,
  UpdatePolicyDto,
} from './dto/create-dimension-policy.dto';
import type { AuthUser } from '@/auth/types/auth-user.type';

type PickResult = {
  rule: any | null;
  suggestion?: { maxWidthIn?: number; maxHeightIn?: number };
};

@Injectable()
export class DimensionPoliciesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) { }

  // -------------------------------------------------
  // Helpers de mapeo
  // -------------------------------------------------
  private toPolicyView(p: any) {
    return {
      id: p.id,
      idSystem: p.idSystem,
      idConfig: p.idConfig,
      idCrystal: p.idCrystal,
      sizeBasis: p.sizeBasis,
      roundingRule: p.roundingRule,
      notes: p.notes,
      isActive: p.isActive,
      systemName: p.sysConf?.system?.name ?? '',
      configName: p.sysConf?.config?.conf ?? '',
      crystalName: p.crystal?.glass ?? '',
    };
  }

  private includeForPolicy() {
    return {
      sysConf: {
        include: {
          system: { select: { name: true } },
          config: { select: { conf: true } },
        },
      },
      crystal: { select: { glass: true } },
    };
  }

  private async policySnapshot(id: number) {
    const p = await this.prisma.dimensionPolicy.findUnique({
      where: { id },
      include: this.includeForPolicy(),
    });
    if (!p) return null;

    const rulesCount = await this.prisma.dimensionRule.count({
      where: { idPolicy: id },
    });

    return {
      id: p.id,
      idSystem: p.idSystem,
      idConfig: p.idConfig,
      idCrystal: p.idCrystal,
      sizeBasis: p.sizeBasis,
      roundingRule: p.roundingRule,
      notes: p.notes ?? null,
      isActive: p.isActive,
      systemName: p.sysConf?.system?.name ?? '',
      configName: p.sysConf?.config?.conf ?? '',
      crystalName: p.crystal?.glass ?? '',
      rulesCount,
    };
  }

  private async logPolicy(params: {
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    actor: AuthUser;
    policyId: number;
    message: string;
    before?: unknown;
    after?: unknown;
    meta?: Record<string, unknown> | null;
    source: string;
  }) {
    await this.logs.log({
      action: params.action,
      entityType: 'DimensionPolicy',
      entityId: params.policyId, // ✅ NO nullable en tu schema
      userId: params.actor?.id ?? null,
      message: params.message,
      before: params.before,
      after: params.after,
      meta: {
        ...(params.meta ?? {}),
        source: params.source,
        actorUserId: params.actor?.id ?? null,
      },
    });
  }

  // -------------------------------------------------
  //                 Policies
  // -------------------------------------------------
  async createPolicy(dto: CreatePolicyDto, actor: AuthUser) {
    // 1) Verificamos que exista la relación System+Config en sys_conf
    const sysConf = await this.prisma.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: dto.idSystem,
          idConfig: dto.idConfig,
        },
      },
    });

    if (!sysConf) {
      throw new BadRequestException(
        'No System + Config relationship found in sys_conf for those IDs. Please check the system associations.',
      );
    }

    // 2) Creamos la policy
    try {
      const created = await this.prisma.dimensionPolicy.create({
        data: {
          idSystem: dto.idSystem,
          idConfig: dto.idConfig,
          idCrystal: dto.idCrystal,
          sizeBasis: dto.sizeBasis,
          roundingRule: dto.roundingRule,
          notes: dto.notes,
          isActive: dto.isActive ?? true,
        },
      });

      // 3) Volvemos a leerla con include para devolver nombres
      const full = await this.prisma.dimensionPolicy.findUnique({
        where: { id: created.id },
        include: this.includeForPolicy(),
      });

      if (!full) {
        throw new NotFoundException('Policy not found after create');
      }

      const afterSnap = await this.policySnapshot(created.id);

      // ✅ LOG CREATE (after liviano)
      await this.logPolicy({
        action: 'CREATE',
        actor,
        policyId: created.id,
        message: `DimensionPolicy created (#${created.id})`,
        after: afterSnap,
        meta: {
          idSystem: dto.idSystem,
          idConfig: dto.idConfig,
          idCrystal: dto.idCrystal,
        },
        source: 'DimensionPoliciesService.createPolicy',
      });

      return this.toPolicyView(full);
    } catch (e: any) {
      if (e.code === 'P2002') {
        throw new BadRequestException(
          'A policy already exists for this exact System + Config + Crystal combination.',
        );
      }
      if (e.code === 'P2003') {
        throw new BadRequestException(
          'The System + Config relationship is not correctly associated (sys_conf foreign key).',
        );
      }
      throw e;
    }
  }

  async getPolicy(id: number) {
    const p = await this.prisma.dimensionPolicy.findUnique({
      where: { id },
      include: {
        ...this.includeForPolicy(),
        rules: true, // 👈 importante
      },
    });

    if (!p) throw new NotFoundException('Policy not found');

    return {
      ...this.toPolicyView(p),
      rules: p.rules.map((r) => ({
        ruleType: r.ruleType ?? DimensionRuleType.MAIN,
        widthIn: Number(r.widthIn),
        heightIn: Number(r.heightIn),
        dpPosPsf: Number(r.dpPosPsf),
        dpNegPsf: Number(r.dpNegPsf),
        screws: r.screws ?? undefined,
        note: r.note ?? undefined,
      })),
    };
  }

  async listPolicies(params?: {
    idSystem?: number;
    idConfig?: number;
    idCrystal?: number;
    activeOnly?: boolean;
  }) {
    const where: any = {};
    if (params?.idSystem != null) where.idSystem = params.idSystem;
    if (params?.idConfig != null) where.idConfig = params.idConfig;
    if (params?.idCrystal != null) where.idCrystal = params.idCrystal;
    if (params?.activeOnly) where.isActive = true;

    const list = await this.prisma.dimensionPolicy.findMany({
      where,
      include: this.includeForPolicy(),
      orderBy: [
        { idSystem: 'asc' },
        { idConfig: 'asc' },
        { idCrystal: 'asc' },
      ],
    });

    return list.map((p) => this.toPolicyView(p));
  }

  async updatePolicy(id: number, dto: UpdatePolicyDto, actor: AuthUser) {
    const beforeSnap = await this.policySnapshot(id);
    if (!beforeSnap) throw new NotFoundException('Policy not found');

    await this.prisma.dimensionPolicy.update({
      where: { id },
      data: dto,
    });

    const full = await this.prisma.dimensionPolicy.findUnique({
      where: { id },
      include: this.includeForPolicy(),
    });

    if (!full) throw new NotFoundException('Policy not found after update');

    const afterSnap = await this.policySnapshot(id);

    const changedFields: string[] = [];
    const cmp = (a: any, b: any) => (a ?? null) !== (b ?? null);

    if ('sizeBasis' in dto && cmp(beforeSnap.sizeBasis, afterSnap?.sizeBasis)) changedFields.push('sizeBasis');
    if ('roundingRule' in dto && cmp(beforeSnap.roundingRule, afterSnap?.roundingRule)) changedFields.push('roundingRule');
    if ('notes' in dto && cmp(beforeSnap.notes, afterSnap?.notes)) changedFields.push('notes');
    if ('isActive' in dto && cmp(beforeSnap.isActive, afterSnap?.isActive)) changedFields.push('isActive');

    // ✅ LOG UPDATE (before/after liviano)
    await this.logPolicy({
      action: 'UPDATE',
      actor,
      policyId: id,
      message: `DimensionPolicy updated (#${id})`,
      before: beforeSnap,
      after: afterSnap,
      meta: {
        changedFields,
      },
      source: 'DimensionPoliciesService.updatePolicy',
    });

    return this.toPolicyView(full);
  }

  async deletePolicy(id: number, actor: AuthUser) {
    const beforeSnap = await this.policySnapshot(id);
    if (!beforeSnap) throw new NotFoundException('Policy not found');

    // cascade a rules ya está en el schema
    const deleted = await this.prisma.dimensionPolicy.delete({ where: { id } });

    // ✅ LOG DELETE (before liviano)
    await this.logPolicy({
      action: 'DELETE',
      actor,
      policyId: id,
      message: `DimensionPolicy deleted (#${id})`,
      before: beforeSnap,
      meta: {
        rulesCount: beforeSnap.rulesCount,
      },
      source: 'DimensionPoliciesService.deletePolicy',
    });

    return deleted;
  }

  // -------------------------------------------------
  //              Rules (bulk upsert)
  // -------------------------------------------------
  async bulkUpsertRules(policyId: number, dto: BulkUpsertRulesDto, actor: AuthUser) {
    const policy = await this.prisma.dimensionPolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Policy not found');

    const ruleType = dto.ruleType ?? DimensionRuleType.MAIN;

    // Validaciones básicas
    this.validateRows(dto.rows, ruleType);

    // before (solo count)
    const beforeCount = await this.prisma.dimensionRule.count({
      where: { idPolicy: policyId },
    });

    await this.prisma.$transaction([
      this.prisma.dimensionRule.deleteMany({
        where: {
          idPolicy: policyId,
          ruleType,
        },
      }),
      this.prisma.dimensionRule.createMany({
        data: dto.rows.map((r) => ({
          idPolicy: policyId,
          ruleType,
          widthIn: r.widthIn,
          heightIn: r.heightIn,
          dpPosPsf: r.dpPosPsf,
          dpNegPsf: r.dpNegPsf,
          screws: r.screws,
          note: r.note ?? null,
        })),
      }),
    ]);

    const afterCount = await this.prisma.dimensionRule.count({
      where: { idPolicy: policyId },
    });

    // ✅ LOG UPDATE (bulk rules) - NO guardamos filas completas
    await this.logs.log({
      action: 'UPDATE',
      entityType: 'DimensionPolicyRules',
      entityId: policyId, // ✅ int, no null
      userId: actor?.id ?? null,
      message: `DimensionPolicy rules bulk upsert (#${policyId})`,
      before: { rulesCount: beforeCount },
      after: { rulesCount: afterCount },
      meta: {
        source: 'DimensionPoliciesService.bulkUpsertRules',
        actorUserId: actor?.id ?? null,
        ruleType,
        rowsInPayload: dto.rows.length,
      },
    });

    return { ok: true, count: dto.rows.length };
  }

  private validateRows(rows: RuleRowDto[], defaultRuleType: DimensionRuleType) {
    if (!rows || rows.length === 0) {
      throw new BadRequestException('No rows provided');
    }

    // 1) Valores válidos
    rows.forEach((r, i) => {
      if (!isFinite(r.widthIn) || r.widthIn <= 0) {
        throw new BadRequestException(`Row ${i}: invalid widthIn`);
      }
      if (!isFinite(r.heightIn) || r.heightIn <= 0) {
        throw new BadRequestException(`Row ${i}: invalid heightIn`);
      }
      if (!isFinite(r.dpPosPsf) || !isFinite(r.dpNegPsf)) {
        throw new BadRequestException(`Row ${i}: invalid psf values`);
      }
      if (!Number.isInteger(r.screws) || r.screws < 0) {
        throw new BadRequestException(`Row ${i}: invalid screws`);
      }
    });

    // 2) Evitar duplicados por ruleType + W + H dentro del mismo CSV
    const keySet = new Set<string>();
    rows.forEach((r, i) => {
      const key = `${defaultRuleType}:${r.widthIn}x${r.heightIn}`;

      if (keySet.has(key)) {
        throw new BadRequestException(
          `Duplicate size (ruleType/widthIn/heightIn) in row ${i}: ${key}`,
        );
      }

      keySet.add(key);
    });
  }

  // -------------------------------------------------
  //           Preview / Validate (NOA)
  // -------------------------------------------------
  async previewValidate(params: {
    idSystem: number;
    idConfig: number;
    idCrystal: number;
    widthIn: number;
    heightIn: number;
    ruleType?: DimensionRuleType;
  }) {
    const policy = await this.prisma.dimensionPolicy.findFirst({
      where: {
        idSystem: params.idSystem,
        idConfig: params.idConfig,
        idCrystal: params.idCrystal,
        isActive: true,
      },
      include: { rules: true },
    });

    const ruleType = params.ruleType ?? DimensionRuleType.MAIN;
    const rules = policy?.rules?.filter((r) => r.ruleType === ruleType) ?? [];

    if (!policy || rules.length === 0) {
      return { ok: false, reason: 'NOT_RATED' as const };
    }

    const widths = rules.map((r) => Number(r.widthIn));
    const heights = rules.map((r) => Number(r.heightIn));
    const minW = Math.min(...widths);
    const minH = Math.min(...heights);

    if (params.widthIn < minW || params.heightIn < minH) {
      return {
        ok: false,
        reason: 'OVERSIZE' as const,
        belowMinimum: true,
        suggestion: {
          minWidthIn: minW,
          minHeightIn: minH,
        },
      };
    }

    const { rule, suggestion } = this.pickRuleWithRounding(
      policy.roundingRule as DimensionRounding,
      rules,
      params.widthIn,
      params.heightIn,
    );

    if (!rule) {
      const widths = rules.map((r) => Number(r.widthIn));
      const heights = rules.map((r) => Number(r.heightIn));
      const maxW = widths.length ? Math.max(...widths) : undefined;
      const maxH = heights.length ? Math.max(...heights) : undefined;

      return {
        ok: false,
        reason: 'OVERSIZE' as const,
        suggestion: suggestion ?? {
          maxWidthIn: maxW,
          maxHeightIn: maxH,
        },
      };
    }

    return {
      ok: true,
      dpPos: Number(rule.dpPosPsf),
      dpNeg: Number(rule.dpNegPsf),
      screws: Number(rule.screws),
      usedRange: {
        w: [Number(rule.widthIn), Number(rule.widthIn)],
        h: [Number(rule.heightIn), Number(rule.heightIn)],
      },
      note: rule.note ?? undefined,
    };
  }

  // W,H exactos o redondeados al siguiente/nearest de la tabla
  private pickRuleWithRounding(
    rounding: DimensionRounding,
    rules: any[],
    w: number,
    h: number,
  ): PickResult {
    if (!rules || rules.length === 0) {
      return { rule: null };
    }

    // 1) Intento exacto (W,H igual a una fila del NOA)
    const direct = this.pickExactRule(rules, w, h);
    if (direct) return { rule: direct };

    // 2) Listas de anchos y altos disponibles en la tabla
    const widthValues = [...new Set(rules.map((r) => Number(r.widthIn)))].sort(
      (a, b) => a - b,
    );
    const heightValues = [...new Set(rules.map((r) => Number(r.heightIn)))].sort(
      (a, b) => a - b,
    );

    if (rounding === DimensionRounding.ROUND_UP_TO_NEXT) {
      const wNext = this.nextOrSame(widthValues, w);
      const hNext = this.nextOrSame(heightValues, h);

      if (wNext != null && hNext != null) {
        const r = this.pickExactRule(rules, wNext, hNext);
        return {
          rule: r,
          suggestion: r ? undefined : { maxWidthIn: wNext, maxHeightIn: hNext },
        };
      }
    } else {
      const wNear = this.nearest(widthValues, w);
      const hNear = this.nearest(heightValues, h);

      if (wNear != null && hNear != null) {
        const r = this.pickExactRule(rules, wNear, hNear);
        return {
          rule: r,
          suggestion: r ? undefined : { maxWidthIn: wNear, maxHeightIn: hNear },
        };
      }
    }

    const maxW = widthValues[widthValues.length - 1];
    const maxH = heightValues[heightValues.length - 1];
    return {
      rule: null,
      suggestion: { maxWidthIn: maxW, maxHeightIn: maxH },
    };
  }

  private pickExactRule(rules: any[], w: number, h: number) {
    return (
      rules.find(
        (r) => Number(r.widthIn) === w && Number(r.heightIn) === h,
      ) ?? null
    );
  }

  private nextOrSame(values: number[], v: number): number | null {
    for (const val of values) {
      if (val >= v) return val;
    }
    return null;
  }

  private nearest(values: number[], v: number): number | null {
    if (!values.length) return null;
    let best = values[0];
    let bestDist = Math.abs(values[0] - v);

    for (const val of values) {
      const d = Math.abs(val - v);
      if (d < bestDist) {
        bestDist = d;
        best = val;
      }
    }
    return best;
  }
}

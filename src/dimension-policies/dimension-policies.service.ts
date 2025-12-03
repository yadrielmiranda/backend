// src/dimension-policies/dimension-policies.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import {
  BulkUpsertRulesDto,
  RuleRowDto,
} from './dto/rule.dto';
import {
  CreatePolicyDto,
  DimensionRounding,
  UpdatePolicyDto,
} from './dto/create-dimension-policy.dto';
import { PrismaService } from 'src/prisma/prisma.service';

type PickResult = {
  rule: any | null;
  suggestion?: { maxWidthIn?: number; maxHeightIn?: number };
};

@Injectable()
export class DimensionPoliciesService {
  constructor(private prisma: PrismaService) { }

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
      // nombres legibles para el frontend
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

  // -------------------------------------------------
  //                 Policies
  // -------------------------------------------------
  async createPolicy(dto: CreatePolicyDto) {
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
      // Esto te da un error claro en lugar del P2003 críptico
      throw new BadRequestException(
        'No existe relación System + Config en sys_conf para esos IDs. Revisa las asociaciones del sistema.'
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

      return this.toPolicyView(full);
    } catch (e: any) {
      if (e.code === 'P2002') {
        // unique sys+conf+crystal
        throw new BadRequestException(
          'Ya existe una policy para esa combinación System + Config + Crystal.'
        );
      }
      if (e.code === 'P2003') {
        // FK rota (por si acaso)
        throw new BadRequestException(
          'La combinación System + Config no está asociada correctamente (FK en sys_conf).'
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
        rules: true,              // 👈 importante
      },
    });

    if (!p) throw new NotFoundException('Policy not found');

    // mapeamos a la vista + reglas
    return {
      ...this.toPolicyView(p),
      rules: p.rules.map((r) => ({
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

  async updatePolicy(id: number, dto: UpdatePolicyDto) {
    await this.prisma.dimensionPolicy.update({
      where: { id },
      data: dto,
    });

    const full = await this.prisma.dimensionPolicy.findUnique({
      where: { id },
      include: this.includeForPolicy(),
    });

    if (!full) throw new NotFoundException('Policy not found after update');

    return this.toPolicyView(full);
  }

  async deletePolicy(id: number) {
    // cascade a rules ya está en el schema
    return this.prisma.dimensionPolicy.delete({ where: { id } });
  }

  // -------------------------------------------------
  //              Rules (bulk upsert)
  // -------------------------------------------------
  async bulkUpsertRules(policyId: number, dto: BulkUpsertRulesDto) {
    const policy = await this.prisma.dimensionPolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Policy not found');

    // Validaciones básicas
    this.validateRows(dto.rows);

    await this.prisma.$transaction([
      // Borramos todas las reglas anteriores de esa policy
      this.prisma.dimensionRule.deleteMany({ where: { idPolicy: policyId } }),

      // Insertamos las nuevas
      this.prisma.dimensionRule.createMany({
        data: dto.rows.map((r) => ({
          idPolicy: policyId,
          widthIn: r.widthIn,
          heightIn: r.heightIn,
          dpPosPsf: r.dpPosPsf,
          dpNegPsf: r.dpNegPsf,
          screws: r.screws,
          note: r.note ?? null,
        })),
      }),
    ]);

    return { ok: true, count: dto.rows.length };
  }

  private validateRows(rows: RuleRowDto[]) {
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
        throw new BadRequestException(`Row ${i}: invalid psf`);
      }
      if (!Number.isInteger(r.screws) || r.screws < 0) {
        throw new BadRequestException(`Row ${i}: invalid screws`);
      }
    });

    // 2) Evitar duplicados W+H dentro del mismo CSV
    const keySet = new Set<string>();
    rows.forEach((r, i) => {
      const key = `${r.widthIn}x${r.heightIn}`;
      if (keySet.has(key)) {
        throw new BadRequestException(
          `Duplicate size (widthIn/heightIn) in row ${i}: ${key}`,
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

    if (!policy || !policy.rules || policy.rules.length === 0) {
      return { ok: false, reason: 'NOT_RATED' as const };
    }

    const widths = policy.rules.map((r) => Number(r.widthIn));
    const heights = policy.rules.map((r) => Number(r.heightIn));
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
      policy.rules,
      params.widthIn,
      params.heightIn,
    );

    if (!rule) {
      const widths = policy.rules.map((r) => Number(r.widthIn));
      const heights = policy.rules.map((r) => Number(r.heightIn));
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
      // nuevo campo: cantidad total de tornillos para ese tamaño
      screws: Number(rule.screws),
      // para no romper el front actual, devolvemos un "rango" degenerado [w,w] / [h,h]
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
      // "si no está, mira la fila con los valores que le siguen"
      const wNext = this.nextOrSame(widthValues, w);
      const hNext = this.nextOrSame(heightValues, h);

      if (wNext != null && hNext != null) {
        const r = this.pickExactRule(rules, wNext, hNext);
        return {
          rule: r,
          suggestion: r
            ? undefined
            : { maxWidthIn: wNext, maxHeightIn: hNext },
        };
      }
    } else {
      // NEAREST: el más cercano en W y el más cercano en H
      const wNear = this.nearest(widthValues, w);
      const hNear = this.nearest(heightValues, h);

      if (wNear != null && hNear != null) {
        const r = this.pickExactRule(rules, wNear, hNear);
        return {
          rule: r,
          suggestion: r
            ? undefined
            : { maxWidthIn: wNear, maxHeightIn: hNear },
        };
      }
    }

    // Si no encontramos nada razonable, devolvemos sugerencia con el máximo
    const maxW = widthValues[widthValues.length - 1];
    const maxH = heightValues[heightValues.length - 1];
    return {
      rule: null,
      suggestion: { maxWidthIn: maxW, maxHeightIn: maxH },
    };
  }

  // Busca una fila exacta W x H en la tabla
  private pickExactRule(rules: any[], w: number, h: number) {
    return (
      rules.find(
        (r) =>
          Number(r.widthIn) === w &&
          Number(r.heightIn) === h,
      ) ?? null
    );
  }

  // Primer valor >= v dentro de la lista ordenada
  private nextOrSame(values: number[], v: number): number | null {
    for (const val of values) {
      if (val >= v) return val;
    }
    return null;
  }

  // Valor más cercano a v dentro de la lista
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

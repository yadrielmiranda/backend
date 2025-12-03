// src/estimates/estimates.service.ts
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import {
  Estimate,
  Prisma,
  PrismaClient,
  GlobalParameterKey,
  Config,
  User,
  Piece,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';
// --- Importación Estándar ---
import Decimal from 'decimal.js'; // Importar el valor/constructor y tipo
import { dimsInchesToFeet } from 'src/pricing/units';
import { areaPerimeterFor } from 'src/pricing/shape-geometry';
import { computeBasePrice } from 'src/pricing/price-formula';
import {
  normalizeInchesToEighthStep,
  DimensionParseError,
} from "src/common/dimensions";


// Prisma Transaction Client Type
type PrismaTransactionClient = Omit<
  PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Helper toDecimal
function toDecimal(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || String(value).trim() === '') { return new Decimal(0); }
  try {
    const decValue = new Decimal(value);
    if (decValue.isNaN()) { console.warn(`Invalid numeric value: "${value}". Defaulting to 0.`); return new Decimal(0); }
    return decValue;
  } catch (error) { throw new BadRequestException(`Invalid numeric format for dimension: ${value}`); }
};


// Tipo interno SÓLO para las métricas calculadas (usando Decimal.js)
type CalculatedMetricsInternal = {
  rate: Decimal; price: Decimal; netProfit: Decimal; markup: Decimal;
  subtotal: Decimal; dealerMarkupDecimal: Decimal; netProfitD: Decimal;
};

// --- Tipo para el OBJETO COMBINADO devuelto por internalCalculate ---
// Contiene el DTO original + las métricas internas
type CalculatedPieceCombined = (CreatePieceDto | UpsertPieceDto) & CalculatedMetricsInternal;


// --- Tipos con Relaciones (para salida final) ---
type PieceWithRelations = Piece & {
  prod: Prisma.ProductGetPayload<{}>; bran: Prisma.BrandGetPayload<{}>; syst: Prisma.SystemGetPayload<{}>;
  conf: Prisma.ConfigGetPayload<{}>; fColor: Prisma.FrameColorGetPayload<{}>; cryst: Prisma.CrystalGetPayload<{}>;
  tin: Prisma.TintGetPayload<{}>; coat: Prisma.CoatingGetPayload<{}>;
};
export type EstimateWithRelations = Estimate & { user: User; pieces: PieceWithRelations[]; };


@Injectable()
export class EstimatesService {
  constructor(private prisma: PrismaService) { }

  // Estima la altura gobernante en función de los flags de Config.
  // FRAME-only: no hacemos conversiones a DLO.
  private async computeGoverningDimsFromConfig(
    pieceDto: {
      idConf: number;
      width?: string | number;
      height?: string | number;
      heightLeft?: string | number;
      heightRight?: string | number;
      legHeight?: string | number;
    },
    tx: any
  ): Promise<{ widthIn: number; heightIn: number }> {
    const cfg = await tx.config.findUnique({ where: { id: pieceDto.idConf } });

    const num = (v: any, label: string) =>
      v == null || v === ""
        ? 0
        : normalizeInchesToEighthStep(v, label, 1); // 👈 mínimo 1"

    const widthIn = num(pieceDto.width, "Width");

    const h = num(pieceDto.height, "Height");
    const hl = cfg?.requiresHeightLeft ? num(pieceDto.heightLeft, "Height Left") : 0;
    const hr = cfg?.requiresHeightRight ? num(pieceDto.heightRight, "Height Right") : 0;
    const lh = cfg?.requiresLegHeight ? num(pieceDto.legHeight, "Leg Height") : 0;

    const heightIn = Math.max(h, hl, hr, lh);
    return { widthIn, heightIn: heightIn || h };
  }


  // --- calculateAndReturnPieceMetrics (Public) ---
  // Devuelve un objeto listo para el frontend/controlador (con Prisma.Decimal)
  async calculateAndReturnPieceMetrics(pieceDto: CreatePieceDto, userId: number): Promise<any> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkupDecimal = user.markupOverride !== null
      ? new Decimal(user.markupOverride.toString()) : new Decimal(user.role.markup.toString());

    // Llama a la lógica interna (devuelve DTO + Métricas Decimal.js)
    const calculated: CalculatedPieceCombined = await this.internalCalculatePieceMetrics(pieceDto, effectiveMarkupDecimal, this.prisma as PrismaTransactionClient);

    // Convertir métricas a Prisma.Decimal y devolver objeto combinado
    return {
      ...pieceDto, // Campos originales del DTO
      id: (pieceDto as UpsertPieceDto).id, // Añadir ID si existe
      // Métricas convertidas
      rate: new Prisma.Decimal(calculated.rate.toFixed(4)),
      price: new Prisma.Decimal(calculated.price.toFixed(2)),
      netProfit: new Prisma.Decimal(calculated.netProfit.toFixed(4)),
      markup: new Prisma.Decimal(calculated.markup.toFixed(4)),
      subtotal: new Prisma.Decimal(calculated.subtotal.toFixed(2)),
      dealerMarkup: new Prisma.Decimal(calculated.dealerMarkupDecimal.toFixed(4)), // Renombrado
      netProfitD: new Prisma.Decimal(calculated.netProfitD.toFixed(2)),
    };
  }

  // --- estimate (Get Single) ---
  async estimate(where: Prisma.EstimateWhereUniqueInput): Promise<EstimateWithRelations | null> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: { user: true, pieces: { orderBy: { id: 'asc' }, include: { prod: true, bran: true, syst: true, conf: true, fColor: true, cryst: true, tin: true, coat: true } } }
    });
    return estimate as EstimateWithRelations | null;
  }

  // --- estimates (Get List) ---
  async estimates(params: { where?: Prisma.EstimateWhereInput }): Promise<EstimateWithRelations[]> {
    const estimates = await this.prisma.estimate.findMany({
      where: params.where, include: { user: true }, orderBy: { date: 'desc' }
    });
    return estimates as EstimateWithRelations[];
  }

  // --- createEstimate ---
  async createEstimate(dto: CreateEstimateDto, userId: number): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkupDecimal = user.markupOverride !== null
      ? new Decimal(user.markupOverride.toString()) : new Decimal(user.role.markup.toString());

    return this.prisma.$transaction(async (tx) => {
      const taxParameter = await tx.globalParameter.findUnique({ where: { key: GlobalParameterKey.SALES_TAX } });
      if (!taxParameter) throw new InternalServerErrorException('SALES_TAX config missing.');
      const taxRate = new Decimal(taxParameter.value.toString()); // taxRate es Decimal

      const lastEstimate = await tx.estimate.findFirst({ orderBy: { number: 'desc' } });
      const nextNumber = !lastEstimate ? '190909' : String(parseInt(lastEstimate.number, 10) + 1);
      // Extraer 'project' si existe en el DTO, pero no lo usamos en createData
      const { pieces: pieceDtos, project, ...estimateHeaderData } = dto;

      // Calcular todas las piezas (devuelve tipo combinado: DTO + Métricas Decimal.js)
      const calculatedPiecesPromises = pieceDtos.map(p => this.internalCalculatePieceMetrics(p, effectiveMarkupDecimal, tx as PrismaTransactionClient));
      const calculatedPieces: CalculatedPieceCombined[] = await Promise.all(calculatedPiecesPromises);

      // Calcular totales del estimado (devuelve Prisma.Decimal)
      // Pasamos el array combinado a internalCalculateEstimateTotals
      const estimateTotals: {
        rateT: Prisma.Decimal; priceT: Prisma.Decimal; netProfit: Prisma.Decimal;
        taxRate: Prisma.Decimal; taxAmount: Prisma.Decimal; totalPayable: Prisma.Decimal;
        total: Prisma.Decimal; netProfitD: Prisma.Decimal;
      } = this.internalCalculateEstimateTotals(calculatedPieces, taxRate);
      // --- FIN CORRECCIÓN ---

      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      // --- CORRECCIÓN: Asegurar que el map DEVUELVE el objeto ---
      // AHORA 'p' es de tipo CalculatedPieceCombined y tiene todas las propiedades
      const piecesToCreate: Prisma.PieceCreateWithoutEstimInput[] = calculatedPieces.map(p => {
        const dataForPrisma: Prisma.PieceCreateWithoutEstimInput = {
          // Acceder a campos del DTO original directamente desde 'p'
          mark: p.mark, privacy: p.privacy, screen: p.screen, muntin: p.muntin, qty: p.qty,
          // Convertir Decimal.js -> Prisma.Decimal
          rate: new Prisma.Decimal(p.rate.toFixed(4)), price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)), subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(4)), netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          // Convertir DTO string? -> Prisma.Decimal | null
          width: p.width ? new Prisma.Decimal(p.width) : null, height: p.height ? new Prisma.Decimal(p.height) : null,
          heightLeft: p.heightLeft ? new Prisma.Decimal(p.heightLeft) : null, heightRight: p.heightRight ? new Prisma.Decimal(p.heightRight) : null,
          legHeight: p.legHeight ? new Prisma.Decimal(p.legHeight) : null,
          // Relaciones
          prod: { connect: { id: p.idProd } }, bran: { connect: { id: p.idBrand } }, syst: { connect: { id: p.idSyst } },
          conf: { connect: { id: p.idConf } }, fColor: { connect: { id: p.idFC } }, cryst: { connect: { id: p.idCryst } },
          tin: { connect: { id: p.idTint } }, coat: { connect: { id: p.idCoat } },
        };
        return dataForPrisma; // <--- CORREGIDO: Faltaba este return
      });
      // --- FIN CORRECCIÓN ---

      // Asegurar que todos los campos necesarios estén presentes en `data`
      const createData: Prisma.EstimateCreateInput = {
        number: nextNumber,
        name: estimateHeaderData.name,
        // project: project, // --- CORRECCIÓN: Campo 'project' eliminado ---
        // Campos de estimateTotals (ahora TypeScript los reconoce)
        rateT: estimateTotals.rateT,
        priceT: estimateTotals.priceT,
        netProfit: estimateTotals.netProfit,
        taxRate: estimateTotals.taxRate,
        taxAmount: estimateTotals.taxAmount,
        totalPayable: estimateTotals.totalPayable,
        total: estimateTotals.total,
        netProfitD: estimateTotals.netProfitD,
        units: totalUnits,
        active: true,
        user: { connect: { id: userId } },
        pieces: { create: piecesToCreate },
      };

      const createdEstimate = await tx.estimate.create({
        data: createData,
        include: { user: true, pieces: { include: { prod: true, bran: true, syst: true, conf: true, fColor: true, cryst: true, tin: true, coat: true } } },
      });
      return createdEstimate as EstimateWithRelations;
    });
  }

  // --- updateEstimate ---
  async updateEstimate(estimateId: number, dto: UpdateEstimateDto, userId: number): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkupDecimal = user.markupOverride !== null
      ? new Decimal(user.markupOverride.toString()) : new Decimal(user.role.markup.toString());

    // --- CORRECCIÓN: Asignar resultado de la transacción y retornarlo ---
    const result = await this.prisma.$transaction(async (tx) => { // <-- Asignar a 'result'
      const taxParameter = await tx.globalParameter.findUnique({ where: { key: GlobalParameterKey.SALES_TAX } });
      if (!taxParameter) throw new InternalServerErrorException('SALES_TAX config missing.');
      const taxRate = new Decimal(taxParameter.value.toString());

      const { pieces: pieceDtos = [], project, ...estimateHeaderData } = dto; // Extraer y ignorar project

      const existingEstimate = await tx.estimate.findUnique({ where: { id: estimateId } });
      if (!existingEstimate || existingEstimate.idUser !== userId) throw new NotFoundException(`Estimate #${estimateId} not found/denied.`);
      if (!existingEstimate.active) throw new BadRequestException(`Estimate #${estimateId} is inactive.`);

      const incomingPieceIds = pieceDtos.map(p => p.id).filter((id): id is number => id !== undefined);
      await tx.piece.deleteMany({ where: { idEst: estimateId, NOT: { id: { in: incomingPieceIds } } } });

      const calculatedPiecesPromises = pieceDtos.map(p => this.internalCalculatePieceMetrics(p, effectiveMarkupDecimal, tx as PrismaTransactionClient));
      const calculatedPieces: CalculatedPieceCombined[] = await Promise.all(calculatedPiecesPromises);

      const estimateTotals: { /*...tipo explícito como en createEstimate...*/ } = this.internalCalculateEstimateTotals(calculatedPieces, taxRate);
      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      const piecesToUpsert = calculatedPieces.map((p) => {
        const upsertData: Omit<Prisma.PieceUncheckedUpdateInput, 'idEst'> & Omit<Prisma.PieceUncheckedCreateInput, 'idEst'> = {
          mark: p.mark, privacy: p.privacy, screen: p.screen, muntin: p.muntin, qty: p.qty,
          rate: new Prisma.Decimal(p.rate.toFixed(4)), price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)), subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(4)), netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          width: p.width ? new Prisma.Decimal(p.width) : null, height: p.height ? new Prisma.Decimal(p.height) : null,
          heightLeft: p.heightLeft ? new Prisma.Decimal(p.heightLeft) : null, heightRight: p.heightRight ? new Prisma.Decimal(p.heightRight) : null,
          legHeight: p.legHeight ? new Prisma.Decimal(p.legHeight) : null,
          idProd: p.idProd, idBrand: p.idBrand, idSyst: p.idSyst, idConf: p.idConf, idFC: p.idFC,
          idCryst: p.idCryst, idTint: p.idTint, idCoat: p.idCoat,
        };
        return {
          where: { id: (p as UpsertPieceDto).id || -1 },
          create: upsertData as Prisma.PieceUncheckedCreateWithoutEstimInput,
          update: upsertData as Prisma.PieceUncheckedUpdateWithoutEstimInput,
        };
      });

      const updateData: Prisma.EstimateUpdateInput = {
        ...estimateHeaderData, // name
        ...estimateTotals,    // rateT, priceT, etc.
        units: totalUnits,
        pieces: { upsert: piecesToUpsert },
      };

      const updatedEstimate = await tx.estimate.update({
        where: { id: estimateId },
        data: updateData,
        include: { user: true, pieces: { include: { prod: true, bran: true, syst: true, conf: true, fColor: true, cryst: true, tin: true, coat: true } } },
      });
      return updatedEstimate; // <-- Retornar dentro de la transacción
    }); // <-- Fin de la transacción

    return result as EstimateWithRelations; // <-- Retornar el resultado casteado
    // --- FIN CORRECCIÓN ---
  }

  // --- deleteEstimate ---
  async deleteEstimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({ where });
      if (!estimate) throw new NotFoundException(`Estimate #${where.id} not found.`);
      if (!estimate.active) throw new BadRequestException(`Estimate #${where.id} is inactive.`);
      await tx.piece.deleteMany({ where: { idEst: where.id } });
      await tx.estimate.delete({ where: { id: where.id } });
      return estimate;
    });
  }

  // --- Dimension Policy Validation (Oversize blocker) ---

  private async validateAgainstDimensionPolicy(
    dto: CreatePieceDto | UpsertPieceDto,
    tx: PrismaTransactionClient
  ): Promise<{
    ok: boolean;
    reason?: 'NOT_RATED' | 'OVERSIZE';
    dpPos?: number;
    dpNeg?: number;
    // dejamos estos campos por compatibilidad, aunque ahora no los usamos
    anchorsPerJamb?: number;
    extraAnchor?: boolean;
    usedRange?: { w: [number, number]; h: [number, number] };

    // sugerencias tanto de máximo como de mínimo
    suggestion?: {
      maxWidthIn?: number;
      maxHeightIn?: number;
      minWidthIn?: number;
      minHeightIn?: number;
    };

    // flag para saber si está por debajo del mínimo
    belowMinimum?: boolean;

    note?: string;
  }> {
    // 1) Buscar Policy activa por System + Config + Crystal
    const policy = await tx.dimensionPolicy.findFirst({
      where: {
        idSystem: dto.idSyst,
        idConfig: dto.idConf,
        idCrystal: dto.idCryst,
        isActive: true,
      },
      include: { rules: true },
    });

    // Si no hay policy o no tiene reglas -> NOT_RATED
    if (!policy || !policy.rules || policy.rules.length === 0) {
      return { ok: false, reason: 'NOT_RATED' };
    }

    // 2) Dimensiones gobernantes (FRAME), igual que antes
    const { widthIn, heightIn } = await this.computeGoverningDimsFromConfig(dto, tx);

    const rules = policy.rules;

    const allWidths = rules.map((r: any) => Number(r.widthIn));
    const allHeights = rules.map((r: any) => Number(r.heightIn));
    const minW = Math.min(...allWidths);
    const minH = Math.min(...allHeights);

    if (widthIn < minW || heightIn < minH) {
      return {
        ok: false,
        reason: 'OVERSIZE',
        belowMinimum: true,
        suggestion: {
          // mínimo “real”
          minWidthIn: minW,
          minHeightIn: minH,
          // también los ponemos en max* para que el front siempre tenga algo
          maxWidthIn: minW,
          maxHeightIn: minH,
        },
      };
    }

    // ---- Helpers específicos para el modelo widthIn/heightIn ----
    const pickExactRule = (w: number, h: number) =>
      rules.find(
        (r: any) =>
          Number(r.widthIn) === w &&
          Number(r.heightIn) === h,
      ) ?? null;

    const uniqueSorted = (arr: number[]) =>
      [...new Set(arr)].sort((a, b) => a - b);

    const widthValues = uniqueSorted(rules.map((r: any) => Number(r.widthIn)));
    const heightValues = uniqueSorted(rules.map((r: any) => Number(r.heightIn)));

    const nextOrSame = (values: number[], v: number): number | null => {
      for (const val of values) {
        if (val >= v) return val;
      }
      return null;
    };

    const nearest = (values: number[], v: number): number | null => {
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
    };

    // 3) Intento EXACTO W x H
    let rule: any | null = pickExactRule(widthIn, heightIn);
    let suggestion: { maxWidthIn?: number; maxHeightIn?: number } | undefined;

    // 4) Si no hay exacto, aplicamos la regla de redondeo de la policy
    if (!rule) {
      if (policy.roundingRule === 'ROUND_UP_TO_NEXT') {
        const wNext = nextOrSame(widthValues, widthIn);
        const hNext = nextOrSame(heightValues, heightIn);

        if (wNext != null && hNext != null) {
          rule = pickExactRule(wNext, hNext);
          if (!rule) {
            suggestion = { maxWidthIn: wNext, maxHeightIn: hNext };
          }
        }
      } else {
        // NEAREST
        const wNear = nearest(widthValues, widthIn);
        const hNear = nearest(heightValues, heightIn);

        if (wNear != null && hNear != null) {
          rule = pickExactRule(wNear, hNear);
          if (!rule) {
            suggestion = { maxWidthIn: wNear, maxHeightIn: hNear };
          }
        }
      }
    }

    // 5) Si todavía no hay regla válida -> OVERSIZE
    if (!rule) {
      const maxW = widthValues[widthValues.length - 1];
      const maxH = heightValues[heightValues.length - 1];
      return {
        ok: false,
        reason: 'OVERSIZE',
        suggestion: suggestion ?? { maxWidthIn: maxW, maxHeightIn: maxH },
      };
    }

    // 6) Encontramos una fila válida
    return {
      ok: true,
      dpPos: Number(rule.dpPosPsf),
      dpNeg: Number(rule.dpNegPsf),
      // anchorsPerJamb / extraAnchor se quedan indefinidos (ya no existen en la tabla)
      usedRange: {
        // rango degenerado [w, w] / [h, h] para no romper el front
        w: [Number(rule.widthIn), Number(rule.widthIn)],
        h: [Number(rule.heightIn), Number(rule.heightIn)],
      },
      note: rule.note ?? undefined,
    };
  }


  // --- internalCalculatePieceMetrics ---
  // Devuelve el tipo combinado (DTO + Métricas Decimal.js)
  private async internalCalculatePieceMetrics(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    effectiveMarkup: Decimal,
    tx: PrismaTransactionClient,
  ): Promise<CalculatedPieceCombined> {

    // 1) Traer la config (nombre + flags). NO cambiamos tu selección.
    const config = await tx.config.findUnique({
      where: { id: pieceDto.idConf },
      select: {
        conf: true,
        requiresWidth: true,
        requiresHeight: true,
        requiresHeightLeft: true,
        requiresHeightRight: true,
        requiresLegHeight: true,
      }
    });
    if (!config) {
      throw new NotFoundException(`Config ID #${pieceDto.idConf} not found.`);
    }

    // (Opcional) Validación mínima en base a flags
    // Puedes quitar este bloque si no quieres validar aquí.
    const need = (v?: number | boolean | null) => v === 1 || v === true;
    const missing: string[] = [];
    if (need(config.requiresWidth) && (pieceDto.width == null)) missing.push('width');
    if (need(config.requiresHeight) && (pieceDto.height == null)) missing.push('height');
    if (need(config.requiresHeightLeft) && (pieceDto.heightLeft == null)) missing.push('heightLeft');
    if (need(config.requiresHeightRight) && (pieceDto.heightRight == null)) missing.push('heightRight');
    if (need(config.requiresLegHeight) && (pieceDto.legHeight == null)) missing.push('legHeight');
    if (missing.length) {
      throw new BadRequestException(`Faltan dimensiones requeridas: ${missing.join(', ')}`);
    }



    // 2) Dimensiones: el usuario ingresa en PULGADAS → convertimos a PIES para la geometría
    const dimsFt = dimsInchesToFeet({
      width: pieceDto.width,
      height: pieceDto.height,
      heightLeft: pieceDto.heightLeft,
      heightRight: pieceDto.heightRight,
      legHeight: pieceDto.legHeight,
    });

    // 2.b) BLOQUEO OVERSIZE según DimensionPolicy

    // 2.b) BLOQUEO OVERSIZE según DimensionPolicy
    const dpCheck = await this.validateAgainstDimensionPolicy(pieceDto, tx);
    if (!dpCheck.ok) {
      if (dpCheck.reason === 'NOT_RATED') {
        throw new BadRequestException(
          'No hay política de dimensiones (NOT_RATED) para este System+Config+Crystal.',
        );
      }

      if (dpCheck.reason === 'OVERSIZE') {
        const minW = dpCheck.suggestion?.minWidthIn;
        const minH = dpCheck.suggestion?.minHeightIn;
        const hasMinSuggestion = minW != null || minH != null;

        // Caso: por debajo del mínimo → usamos los campos minWidthIn/minHeightIn
        if (hasMinSuggestion) {
          const sug = ` El tamaño mínimo permitido es W=${minW ?? '-'
            }″, H=${minH ?? '-'}″.`;
          throw new BadRequestException(`Revise las dimensiones.${sug}`);
        }

        // Caso: por encima del máximo → usamos maxWidthIn/maxHeightIn
        const maxW = dpCheck.suggestion?.maxWidthIn;
        const maxH = dpCheck.suggestion?.maxHeightIn;
        const hasMaxSuggestion = maxW != null || maxH != null;

        const sug = hasMaxSuggestion
          ? ` Sugerido máx: W=${maxW ?? '-'}″, H=${maxH ?? '-'}″.`
          : '';

        throw new BadRequestException(
          `La pieza excede los límites del NOA para esta combinación.${sug}`,
        );
      }
    }


    // 3) Área y Perímetro en pies (ft² / ft) según el nombre de la configuración
    //    Soporta Tombstone/Eyebrow y sus HALF como "mitad vertical", tal como definimos.
    const { areaFt2, perimeterFt } = areaPerimeterFor(config.conf, dimsFt);

    // 4) Buscar la regla de precio A/B/C para la combinación (como ya hacías)
    const rule = await tx.pricingRule.findUnique({
      where: {
        idBrand_idProduct_idSystem_idConfig_idCrystal: {
          idBrand: pieceDto.idBrand,
          idProduct: pieceDto.idProd,
          idSystem: pieceDto.idSyst,
          idConfig: pieceDto.idConf,
          idCrystal: pieceDto.idCryst,
        }
      }
    });
    if (!rule) {
      throw new NotFoundException(`No pricing rule for piece: ${pieceDto.mark}.`);
    }

    // 5) Precio base (rate) = (Área·A) + (Perímetro·B) + C   —> todo en Decimal
    const A = new Decimal(rule.costoA.toString()); // $/ft² vidrio
    const B = new Decimal(rule.costoB.toString()); // $/ft lineal marco
    const C = new Decimal(rule.costoC.toString()); // $ fijo/unidad
    const areaFt2Dec = new Decimal(areaFt2);
    const perimeterFtDec = new Decimal(perimeterFt);

    const rate = computeBasePrice(areaFt2Dec, perimeterFtDec, A, B, C);

    // 6) Tu lógica de markup / dealer markup (igual que ya tenías)
    const markupAmount = rate.mul(effectiveMarkup);
    const price = rate.add(markupAmount);
    const netProfit = price.sub(rate);

    const dealerMarkupFromDto = new Decimal(pieceDto.dealerMarkup || 0);
    const dealerMarkupDecimal = dealerMarkupFromDto.div(100);
    const dealerMarkupAmount = price.mul(dealerMarkupDecimal);

    const subtotal = price;           // tu "price" antes de dealer markup visible
    const netProfitD = dealerMarkupAmount; // ganancia dealer

    // 7) Devolver objeto COMBINADO (DTO + métricas Decimal.js), tal como usas en el resto del servicio
    const result: CalculatedPieceCombined = {
      ...(pieceDto as any),

      rate,                 // Decimal
      price,                // Decimal
      netProfit,            // Decimal
      markup: effectiveMarkup,          // Decimal (el markup aplicado)
      dealerMarkupDecimal,             // Decimal (0.xx)
      netProfitD,                      // Decimal
      subtotal,                        // Decimal
    };

    return result;
  }


  // --- calculateEstimateTotals ---
  // Usa Decimal internamente y devuelve Prisma.Decimal
  private internalCalculateEstimateTotals(
    // Espera el array combinado
    pieces: CalculatedPieceCombined[],
    taxRate: Decimal
  ): { // Devuelve este tipo explícito
    rateT: Prisma.Decimal; priceT: Prisma.Decimal; netProfit: Prisma.Decimal;
    taxRate: Prisma.Decimal; taxAmount: Prisma.Decimal; totalPayable: Prisma.Decimal;
    total: Prisma.Decimal; netProfitD: Prisma.Decimal;
  } {
    const zero = new Decimal(0);
    // Acumulador con tipo explícito
    const totals: { rateT: Decimal, priceT: Decimal, total: Decimal, netProfitD: Decimal } =
      pieces.reduce((acc, piece) => {
        // Acceder a qty y métricas desde el objeto combinado
        const qty = new Decimal(piece.qty || 0);
        acc.rateT = acc.rateT.add(piece.rate.mul(qty));
        acc.priceT = acc.priceT.add(piece.price.mul(qty));
        const dealerProfitPiece = piece.price.mul(piece.dealerMarkupDecimal);
        const finalPricePiece = piece.price.add(dealerProfitPiece);
        acc.netProfitD = acc.netProfitD.add(dealerProfitPiece.mul(qty));
        acc.total = acc.total.add(finalPricePiece.mul(qty));
        return acc;
      }, { rateT: zero, priceT: zero, total: zero, netProfitD: zero });

    const yourNetProfit = totals.priceT.sub(totals.rateT);
    const taxAmount = totals.priceT.mul(taxRate);
    const totalPayable = totals.priceT.add(taxAmount);

    // Convert to Prisma.Decimal
    return {
      rateT: new Prisma.Decimal(totals.rateT.toFixed(4)), priceT: new Prisma.Decimal(totals.priceT.toFixed(2)),
      netProfit: new Prisma.Decimal(yourNetProfit.toFixed(4)), taxRate: new Prisma.Decimal(taxRate.toFixed(4)),
      taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)), totalPayable: new Prisma.Decimal(totalPayable.toFixed(2)),
      total: new Prisma.Decimal(totals.total.toFixed(2)), netProfitD: new Prisma.Decimal(totals.netProfitD.toFixed(2)),
    };
  }

  // Permite validar sin crear pieza
  async previewDimensionValidation(input: {
    idSyst: number; idConf: number; idCryst: number;
    width: number; height: number;
    heightLeft?: number; heightRight?: number; legHeight?: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // construye un dto parecido al que usa internalCalculatePieceMetrics
      const dto: any = {
        idSyst: input.idSyst,
        idConf: input.idConf,
        idCryst: input.idCryst,
        width: String(input.width),
        height: String(input.height),
        heightLeft: input.heightLeft != null ? String(input.heightLeft) : undefined,
        heightRight: input.heightRight != null ? String(input.heightRight) : undefined,
        legHeight: input.legHeight != null ? String(input.legHeight) : undefined,
      };

      const res = await this.validateAgainstDimensionPolicy(dto, tx);
      if (!res.ok) return res;
      return {
        ok: true,
        dpPos: res.dpPos,
        dpNeg: res.dpNeg,
        usedRange: res.usedRange,
        note: res.note,
      };
    });
  }


} // End Class
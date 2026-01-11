// src/estimates/estimates.service.ts
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import {
  Estimate,
  EstimateStatus,
  Prisma,
  PrismaClient,
  GlobalParameterKey,
  User,
  Piece,
  Order, // ✅ añadido
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';

// --- Importación Estándar ---
import Decimal from 'decimal.js';
import { dimsInchesToFeet } from 'src/pricing/units';
import { areaPerimeterFor } from 'src/pricing/shape-geometry';
import { computeBasePrice } from 'src/pricing/price-formula';
import { normalizeInchesToEighthStep } from 'src/common/dimensions';
import type { AuthUser } from 'src/auth/types/auth-user.type';
import { isPrivileged } from 'src/auth/utils/is-privileged';

// Prisma Transaction Client Type
type PrismaTransactionClient = Omit<
  PrismaClient,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
>;

// Tipo interno SÓLO para las métricas calculadas (usando Decimal.js)
type CalculatedMetricsInternal = {
  rate: Decimal; // costo fabrica (unitario)
  price: Decimal; // tu precio al dealer/cliente (unitario)
  netProfit: Decimal; // tu ganancia (unitaria)
  markup: Decimal; // tu markup (0.30, etc.)
  subtotal: Decimal; // tu subtotal
  dealerMarkupDecimal: Decimal; // markup dealer en fracción (0.15)
  netProfitD: Decimal; // ganancia dealer (total)
  customerPrice: Decimal; // precio unitario al cliente final
  customerSubtotal: Decimal; // precio * qty al cliente final
  dpPosPsf: Decimal;
  dpNegPsf: Decimal;
};

// Contiene el DTO original + las métricas internas
type CalculatedPieceCombined = (CreatePieceDto | UpsertPieceDto) &
  CalculatedMetricsInternal;

// --- Tipos con Relaciones (para salida final) ---
type PieceWithRelations = Piece & {
  prod: Prisma.ProductGetPayload<{}>;
  bran: Prisma.BrandGetPayload<{}>;
  syst: Prisma.SystemGetPayload<{}>;
  conf: Prisma.ConfigGetPayload<{}>;
  fColor: Prisma.FrameColorGetPayload<{}>;
  cryst: Prisma.CrystalGetPayload<{}>;
  tin: Prisma.TintGetPayload<{}>;
  coat: Prisma.CoatingGetPayload<{}>;
};

// ✅ incluimos order para que el front sepa si ya fue ordenado
export type EstimateWithRelations = Estimate & {
  user: User;
  pieces: PieceWithRelations[];
  order?: Order | null;
  status?: EstimateStatus | null; // ✅ tipado real, no any
};

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
    tx: any,
  ): Promise<{ widthIn: number; heightIn: number }> {
    const cfg = await tx.config.findUnique({ where: { id: pieceDto.idConf } });

    const num = (v: any, label: string) =>
      v == null || v === '' ? 0 : normalizeInchesToEighthStep(v, label, 1); // 👈 mínimo 1"

    const widthIn = num(pieceDto.width, 'Width');

    const h = num(pieceDto.height, 'Height');
    const hl = cfg?.requiresHeightLeft ? num(pieceDto.heightLeft, 'Height Left') : 0;
    const hr = cfg?.requiresHeightRight ? num(pieceDto.heightRight, 'Height Right') : 0;
    const lh = cfg?.requiresLegHeight ? num(pieceDto.legHeight, 'Leg Height') : 0;

    const heightIn = Math.max(h, hl, hr, lh);
    return { widthIn, heightIn: heightIn || h };
  }

  // --- calculateAndReturnPieceMetrics (Public) ---
  async calculateAndReturnPieceMetrics(
    pieceDto: CreatePieceDto,
    userId: number,
  ): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const effectiveMarkupDecimal =
      user.markupOverride !== null
        ? new Decimal(user.markupOverride.toString())
        : new Decimal(user.role.markup.toString());

    const calculated: CalculatedPieceCombined =
      await this.internalCalculatePieceMetrics(
        pieceDto,
        effectiveMarkupDecimal,
        this.prisma as PrismaTransactionClient,
      );

    return {
      ...pieceDto,
      id: (pieceDto as UpsertPieceDto).id,
      rate: new Prisma.Decimal(calculated.rate.toFixed(2)),
      price: new Prisma.Decimal(calculated.price.toFixed(2)),
      netProfit: new Prisma.Decimal(calculated.netProfit.toFixed(2)),
      markup: new Prisma.Decimal(calculated.markup.toFixed(4)),
      subtotal: new Prisma.Decimal(calculated.subtotal.toFixed(2)),
      dealerMarkup: new Prisma.Decimal(calculated.dealerMarkupDecimal.toFixed(4)),
      netProfitD: new Prisma.Decimal(calculated.netProfitD.toFixed(2)),
      customerPrice: new Prisma.Decimal(calculated.customerPrice.toFixed(2)),
      customerSubtotal: new Prisma.Decimal(calculated.customerSubtotal.toFixed(2)),
      dpPosPsf: new Prisma.Decimal(calculated.dpPosPsf.toFixed(2)),
      dpNegPsf: new Prisma.Decimal(calculated.dpNegPsf.toFixed(2)),
    };
  }

  // --- estimate (Get Single) ---
  async estimate(
    where: Prisma.EstimateWhereUniqueInput,
  ): Promise<EstimateWithRelations | null> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: {
        user: true,
        status: true, // ✅ nuevo
        order: true,
        pieces: {
          orderBy: { id: 'asc' },
          include: {
            prod: true,
            bran: true,
            syst: true,
            conf: true,
            fColor: true,
            cryst: true,
            tin: true,
            coat: true,
          },
        },
      },
    });

    return estimate as EstimateWithRelations | null;
  }

  // --- estimates (Get List) ---
  async estimates(params: {
    where?: Prisma.EstimateWhereInput;
  }): Promise<EstimateWithRelations[]> {
    const estimates = await this.prisma.estimate.findMany({
      where: params.where,
      include: {
        user: true,
        status: true, // ✅ necesario para el badge/acciones del frontend
        order: true,  // ✅ recomendado (para fallback y bloqueo)
      },
      orderBy: { date: 'desc' },
    });

    return estimates as EstimateWithRelations[];
  }


  async findAllForUser(user: AuthUser) {
    if (isPrivileged(user)) {
      return this.estimates({ where: {} });
    }

    return this.estimates({
      where: { idUser: user.id },
    });
  }

  async findOneForUser(id: number, user: AuthUser) {
    const estimate = await this.estimate({ id });
    if (!estimate) throw new NotFoundException(`Estimate with ID #${id} not found.`);

    if (isPrivileged(user)) return estimate;

    if (estimate.idUser !== user.id) {
      throw new NotFoundException(`Estimate with ID #${id} not found.`);
    }

    return estimate;
  }

  async assertEstimateOwnerOrThrow(id: number, user: AuthUser) {
    const estimate = await this.prisma.estimate.findUnique({
      where: { id },
      select: {
        id: true,
        idUser: true,
        status: { select: { id: true, name: true } },
      },
    });

    if (!estimate) throw new NotFoundException(`Estimate with ID #${id} not found.`);

    if (estimate.idUser !== user.id) {
      throw new NotFoundException(`Estimate with ID #${id} not found.`);
    }

    return estimate;
  }

  // --- createEstimate ---
  async createEstimate(dto: CreateEstimateDto, userId: number): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const effectiveMarkupDecimal =
      user.markupOverride !== null
        ? new Decimal(user.markupOverride.toString())
        : new Decimal(user.role.markup.toString());

    return this.prisma.$transaction(async (tx) => {
      const taxParameter = await tx.globalParameter.findUnique({
        where: { key: GlobalParameterKey.SALES_TAX },
      });
      if (!taxParameter) throw new InternalServerErrorException('SALES_TAX config missing.');

      // ✅ Buscar status "Active" sin asumir ID
      const activeStatus = await tx.estimateStatus.findUnique({
        where: { name: 'Active' },
        select: { id: true },
      });

      if (!activeStatus) {
        throw new InternalServerErrorException('EstimateStatus "Active" not seeded.');
      }

      const factoryTaxRate = user.isTaxExempt
        ? new Decimal(0)
        : new Decimal(taxParameter.value.toString());

      const rawCustomerTaxRate = dto.customerTaxRate ?? 0;
      const customerTaxRate = new Decimal(rawCustomerTaxRate);

      const lastEstimate = await tx.estimate.findFirst({ orderBy: { number: 'desc' } });
      const nextNumber = !lastEstimate ? '190909' : String(parseInt(lastEstimate.number, 10) + 1);

      const {
        pieces: pieceDtos,
        customerTaxRate: _ignoredCustomerTaxRate,
        ...estimateHeaderData
      } = dto;

      const calculatedPiecesPromises = pieceDtos.map((p) =>
        this.internalCalculatePieceMetrics(p, effectiveMarkupDecimal, tx as PrismaTransactionClient),
      );
      const calculatedPieces: CalculatedPieceCombined[] = await Promise.all(calculatedPiecesPromises);

      const estimateTotals = this.internalCalculateEstimateTotals(
        calculatedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      const piecesToCreate: Prisma.PieceCreateWithoutEstimInput[] = calculatedPieces.map((p) => {
        const dataForPrisma: Prisma.PieceCreateWithoutEstimInput = {
          mark: p.mark,
          privacy: p.privacy,
          screen: p.screen,
          muntin: p.muntin,
          qty: p.qty,

          rate: new Prisma.Decimal(p.rate.toFixed(2)),
          price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)),
          subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(2)),
          netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          customerPrice: new Prisma.Decimal(p.customerPrice.toFixed(2)),
          customerSubtotal: new Prisma.Decimal(p.customerSubtotal.toFixed(2)),

          width: p.width ? new Prisma.Decimal(p.width) : null,
          height: p.height ? new Prisma.Decimal(p.height) : null,
          heightLeft: p.heightLeft ? new Prisma.Decimal(p.heightLeft) : null,
          heightRight: p.heightRight ? new Prisma.Decimal(p.heightRight) : null,
          legHeight: p.legHeight ? new Prisma.Decimal(p.legHeight) : null,

          prod: { connect: { id: p.idProd } },
          bran: { connect: { id: p.idBrand } },
          syst: { connect: { id: p.idSyst } },
          conf: { connect: { id: p.idConf } },
          fColor: { connect: { id: p.idFC } },
          cryst: { connect: { id: p.idCryst } },
          tin: { connect: { id: p.idTint } },
          coat: { connect: { id: p.idCoat } },

          dpPosPsf: new Prisma.Decimal(p.dpPosPsf.toFixed(2)),
          dpNegPsf: new Prisma.Decimal(p.dpNegPsf.toFixed(2)),
        };
        return dataForPrisma;
      });

      const createData: Prisma.EstimateCreateInput = {
        number: nextNumber,
        name: estimateHeaderData.name,

        customerFirstName: estimateHeaderData.customerFirstName ?? null,
        customerLastName: estimateHeaderData.customerLastName ?? null,
        customerEmail: estimateHeaderData.customerEmail ?? null,
        customerPhone: estimateHeaderData.customerPhone ?? null,
        customerStreet: estimateHeaderData.customerStreet ?? null,
        customerCity: estimateHeaderData.customerCity ?? null,
        customerState: estimateHeaderData.customerState ?? null,
        customerPostalCode: estimateHeaderData.customerPostalCode ?? null,

        rateT: estimateTotals.rateT,
        priceT: estimateTotals.priceT,
        netProfit: estimateTotals.netProfit,

        taxRate: estimateTotals.taxRate,
        taxAmount: estimateTotals.taxAmount,
        totalPayable: estimateTotals.totalPayable,

        customerPriceT: estimateTotals.customerPriceT,
        customerTaxRate: estimateTotals.customerTaxRate,
        customerTaxAmount: estimateTotals.customerTaxAmount,
        customerTotalPayable: estimateTotals.customerTotalPayable,

        netProfitD: estimateTotals.netProfitD,

        units: totalUnits,

        // ✅ status por defecto
        status: { connect: { id: activeStatus.id } },

        user: { connect: { id: userId } },
        pieces: { create: piecesToCreate },
      };

      const createdEstimate = await tx.estimate.create({
        data: createData,
        include: {
          user: true,
          status: true,
          order: true,
          pieces: {
            include: { prod: true, bran: true, syst: true, conf: true, fColor: true, cryst: true, tin: true, coat: true },
          },
        },
      });

      return createdEstimate as EstimateWithRelations;
    });
  }

  // --- updateEstimate ---
  async updateEstimate(
    estimateId: number,
    dto: UpdateEstimateDto,
    userId: number,
  ): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const effectiveMarkupDecimal =
      user.markupOverride !== null
        ? new Decimal(user.markupOverride.toString())
        : new Decimal(user.role.markup.toString());

    const result = await this.prisma.$transaction(async (tx) => {
      const taxParameter = await tx.globalParameter.findUnique({
        where: { key: GlobalParameterKey.SALES_TAX },
      });
      if (!taxParameter) throw new InternalServerErrorException('SALES_TAX config missing.');

      const factoryTaxRate = user.isTaxExempt
        ? new Decimal(0)
        : new Decimal(taxParameter.value.toString());

      // ✅ ahora bloqueamos por status + order
      const existingEstimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        select: {
          id: true,
          idUser: true,
          customerTaxRate: true,
          status: { select: { name: true } },
          order: { select: { id: true } },
        },
      });

      if (!existingEstimate || existingEstimate.idUser !== userId) {
        throw new NotFoundException(`Estimate #${estimateId} not found/denied.`);
      }

      if (existingEstimate.status?.name !== 'Active') {
        throw new BadRequestException(
          `Estimate #${estimateId} no se puede editar (status: ${existingEstimate.status?.name ?? 'UNKNOWN'}).`,
        );
      }

      if (existingEstimate.order) {
        throw new BadRequestException(`Estimate #${estimateId} ya tiene una orden y no se puede editar.`);
      }

      const {
        pieces: pieceDtos = [],
        customerTaxRate: rawCustomerTaxRate,
        ...estimateHeaderData
      } = dto;

      const customerTaxRate = new Decimal(
        rawCustomerTaxRate ?? Number(existingEstimate.customerTaxRate ?? 0),
      );

      const incomingPieceIds = pieceDtos
        .map((p) => p.id)
        .filter((id): id is number => id !== undefined);

      await tx.piece.deleteMany({
        where: { idEst: estimateId, NOT: { id: { in: incomingPieceIds } } },
      });

      const calculatedPiecesPromises = pieceDtos.map((p) =>
        this.internalCalculatePieceMetrics(p, effectiveMarkupDecimal, tx as PrismaTransactionClient),
      );
      const calculatedPieces: CalculatedPieceCombined[] = await Promise.all(calculatedPiecesPromises);

      const estimateTotals = this.internalCalculateEstimateTotals(
        calculatedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      const piecesToUpsert = calculatedPieces.map((p) => {
        const upsertData: Omit<Prisma.PieceUncheckedUpdateInput, 'idEst'> &
          Omit<Prisma.PieceUncheckedCreateInput, 'idEst'> = {
          mark: p.mark,
          privacy: p.privacy,
          screen: p.screen,
          muntin: p.muntin,
          qty: p.qty,

          rate: new Prisma.Decimal(p.rate.toFixed(2)),
          price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)),
          subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(2)),
          netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          customerPrice: new Prisma.Decimal(p.customerPrice.toFixed(2)),
          customerSubtotal: new Prisma.Decimal(p.customerSubtotal.toFixed(2)),

          width: p.width ? new Prisma.Decimal(p.width) : null,
          height: p.height ? new Prisma.Decimal(p.height) : null,
          heightLeft: p.heightLeft ? new Prisma.Decimal(p.heightLeft) : null,
          heightRight: p.heightRight ? new Prisma.Decimal(p.heightRight) : null,
          legHeight: p.legHeight ? new Prisma.Decimal(p.legHeight) : null,

          idProd: p.idProd,
          idBrand: p.idBrand,
          idSyst: p.idSyst,
          idConf: p.idConf,
          idFC: p.idFC,
          idCryst: p.idCryst,
          idTint: p.idTint,
          idCoat: p.idCoat,

          dpPosPsf: new Prisma.Decimal(p.dpPosPsf.toFixed(2)),
          dpNegPsf: new Prisma.Decimal(p.dpNegPsf.toFixed(2)),
        };

        return {
          where: { id: (p as UpsertPieceDto).id || -1 },
          create: upsertData as Prisma.PieceUncheckedCreateWithoutEstimInput,
          update: upsertData as Prisma.PieceUncheckedUpdateWithoutEstimInput,
        };
      });

      const updateData: Prisma.EstimateUpdateInput = {
        ...(estimateHeaderData.name !== undefined ? { name: estimateHeaderData.name } : {}),

        ...(estimateHeaderData.customerFirstName !== undefined
          ? { customerFirstName: estimateHeaderData.customerFirstName }
          : {}),
        ...(estimateHeaderData.customerLastName !== undefined
          ? { customerLastName: estimateHeaderData.customerLastName }
          : {}),
        ...(estimateHeaderData.customerEmail !== undefined
          ? { customerEmail: estimateHeaderData.customerEmail }
          : {}),
        ...(estimateHeaderData.customerPhone !== undefined
          ? { customerPhone: estimateHeaderData.customerPhone }
          : {}),
        ...(estimateHeaderData.customerStreet !== undefined
          ? { customerStreet: estimateHeaderData.customerStreet }
          : {}),
        ...(estimateHeaderData.customerCity !== undefined
          ? { customerCity: estimateHeaderData.customerCity }
          : {}),
        ...(estimateHeaderData.customerState !== undefined
          ? { customerState: estimateHeaderData.customerState }
          : {}),
        ...(estimateHeaderData.customerPostalCode !== undefined
          ? { customerPostalCode: estimateHeaderData.customerPostalCode }
          : {}),

        ...estimateTotals,
        units: totalUnits,
        pieces: { upsert: piecesToUpsert },
      };

      const updatedEstimate = await tx.estimate.update({
        where: { id: estimateId },
        data: updateData,
        include: {
          user: true,
          status: true,
          order: true,
          pieces: {
            include: { prod: true, bran: true, syst: true, conf: true, fColor: true, cryst: true, tin: true, coat: true },
          },
        },
      });

      return updatedEstimate;
    });

    return result as EstimateWithRelations;
  }

  // --- deleteEstimate ---
  async deleteEstimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where,
        select: {
          id: true,
          status: { select: { name: true } },
          order: { select: { id: true } },
        },
      });

      if (!estimate) {
        throw new NotFoundException(`Estimate #${where.id} not found.`);
      }

      if (estimate.status?.name !== 'Active') {
        throw new BadRequestException(
          `Estimate #${where.id} no se puede borrar (status: ${estimate.status?.name ?? 'UNKNOWN'}).`,
        );
      }

      if (estimate.order) {
        throw new BadRequestException(`Estimate #${where.id} ya tiene una orden y no se puede borrar.`);
      }

      await tx.piece.deleteMany({ where: { idEst: where.id } });
      await tx.estimate.delete({ where: { id: where.id } });

      return estimate as unknown as Estimate;
    });
  }

  // --- Dimension Policy Validation (Oversize blocker) ---
  private async validateAgainstDimensionPolicy(
    dto: CreatePieceDto | UpsertPieceDto,
    tx: PrismaTransactionClient,
  ): Promise<{
    ok: boolean;
    reason?: 'NOT_RATED' | 'OVERSIZE';
    dpPos?: number;
    dpNeg?: number;
    anchorsPerJamb?: number;
    extraAnchor?: boolean;
    usedRange?: { w: [number, number]; h: [number, number] };
    suggestion?: {
      maxWidthIn?: number;
      maxHeightIn?: number;
      minWidthIn?: number;
      minHeightIn?: number;
    };
    belowMinimum?: boolean;
    note?: string;
  }> {
    const policy = await tx.dimensionPolicy.findFirst({
      where: {
        idSystem: dto.idSyst,
        idConfig: dto.idConf,
        idCrystal: dto.idCryst,
        isActive: true,
      },
      include: { rules: true },
    });

    if (!policy || !policy.rules || policy.rules.length === 0) {
      return { ok: false, reason: 'NOT_RATED' };
    }

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
          minWidthIn: minW,
          minHeightIn: minH,
          maxWidthIn: minW,
          maxHeightIn: minH,
        },
      };
    }

    const pickExactRule = (w: number, h: number) =>
      rules.find((r: any) => Number(r.widthIn) === w && Number(r.heightIn) === h) ?? null;

    const uniqueSorted = (arr: number[]) => [...new Set(arr)].sort((a, b) => a - b);

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

    let rule: any | null = pickExactRule(widthIn, heightIn);
    let suggestion: { maxWidthIn?: number; maxHeightIn?: number } | undefined;

    if (!rule) {
      if (policy.roundingRule === 'ROUND_UP_TO_NEXT') {
        const wNext = nextOrSame(widthValues, widthIn);
        const hNext = nextOrSame(heightValues, heightIn);

        if (wNext != null && hNext != null) {
          rule = pickExactRule(wNext, hNext);
          if (!rule) suggestion = { maxWidthIn: wNext, maxHeightIn: hNext };
        }
      } else {
        const wNear = nearest(widthValues, widthIn);
        const hNear = nearest(heightValues, heightIn);

        if (wNear != null && hNear != null) {
          rule = pickExactRule(wNear, hNear);
          if (!rule) suggestion = { maxWidthIn: wNear, maxHeightIn: hNear };
        }
      }
    }

    if (!rule) {
      const maxW = widthValues[widthValues.length - 1];
      const maxH = heightValues[heightValues.length - 1];
      return {
        ok: false,
        reason: 'OVERSIZE',
        suggestion: suggestion ?? { maxWidthIn: maxW, maxHeightIn: maxH },
      };
    }

    return {
      ok: true,
      dpPos: Number(rule.dpPosPsf),
      dpNeg: Number(rule.dpNegPsf),
      usedRange: {
        w: [Number(rule.widthIn), Number(rule.widthIn)],
        h: [Number(rule.heightIn), Number(rule.heightIn)],
      },
      note: rule.note ?? undefined,
    };
  }

  // --- internalCalculatePieceMetrics ---
  private async internalCalculatePieceMetrics(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    effectiveMarkup: Decimal,
    tx: PrismaTransactionClient,
  ): Promise<CalculatedPieceCombined> {
    const config = await tx.config.findUnique({
      where: { id: pieceDto.idConf },
      select: {
        conf: true,
        requiresWidth: true,
        requiresHeight: true,
        requiresHeightLeft: true,
        requiresHeightRight: true,
        requiresLegHeight: true,
      },
    });

    if (!config) {
      throw new NotFoundException(`Config ID #${pieceDto.idConf} not found.`);
    }

    const need = (v?: number | boolean | null) => v === 1 || v === true;
    const missing: string[] = [];
    if (need(config.requiresWidth) && pieceDto.width == null) missing.push('width');
    if (need(config.requiresHeight) && pieceDto.height == null) missing.push('height');
    if (need(config.requiresHeightLeft) && pieceDto.heightLeft == null) missing.push('heightLeft');
    if (need(config.requiresHeightRight) && pieceDto.heightRight == null) missing.push('heightRight');
    if (need(config.requiresLegHeight) && pieceDto.legHeight == null) missing.push('legHeight');
    if (missing.length) {
      throw new BadRequestException(`Faltan dimensiones requeridas: ${missing.join(', ')}`);
    }

    const dimsFt = dimsInchesToFeet({
      width: pieceDto.width,
      height: pieceDto.height,
      heightLeft: pieceDto.heightLeft,
      heightRight: pieceDto.heightRight,
      legHeight: pieceDto.legHeight,
    });

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

        if (hasMinSuggestion) {
          const sug = ` El tamaño mínimo permitido es W=${minW ?? '-'}″, H=${minH ?? '-'}″.`;
          throw new BadRequestException(`Revise las dimensiones.${sug}`);
        }

        const maxW = dpCheck.suggestion?.maxWidthIn;
        const maxH = dpCheck.suggestion?.maxHeightIn;
        const hasMaxSuggestion = maxW != null || maxH != null;

        const sug = hasMaxSuggestion ? ` Sugerido máx: W=${maxW ?? '-'}″, H=${maxH ?? '-'}″.` : '';

        throw new BadRequestException(
          `La pieza excede los límites del NOA para esta combinación.${sug}`,
        );
      }
    }

    const dpPosPsf = new Decimal(dpCheck.dpPos ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const dpNegPsf = new Decimal(dpCheck.dpNeg ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const { areaFt2, perimeterFt } = areaPerimeterFor(config.conf, dimsFt);

    const rule = await tx.pricingRule.findUnique({
      where: {
        idBrand_idProduct_idSystem_idConfig_idCrystal: {
          idBrand: pieceDto.idBrand,
          idProduct: pieceDto.idProd,
          idSystem: pieceDto.idSyst,
          idConfig: pieceDto.idConf,
          idCrystal: pieceDto.idCryst,
        },
      },
    });

    if (!rule) {
      throw new NotFoundException(`No pricing rule for piece: ${pieceDto.mark}.`);
    }

    const A = new Decimal(rule.costoA.toString());
    const B = new Decimal(rule.costoB.toString());
    const C = new Decimal(rule.costoC.toString());
    const areaFt2Dec = new Decimal(areaFt2);
    const perimeterFtDec = new Decimal(perimeterFt);

    const rate = computeBasePrice(areaFt2Dec, perimeterFtDec, A, B, C);

    const markupAmount = rate.mul(effectiveMarkup);
    const price = rate.add(markupAmount);
    const netProfit = price.sub(rate);

    const dealerMarkupFromDto = new Decimal((pieceDto as any).dealerMarkup || 0);
    const dealerMarkupDecimal = dealerMarkupFromDto.div(100);

    const qtyDec = new Decimal(pieceDto.qty || 1);

    const rateR = rate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const priceR = price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const netProfitR = netProfit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const markupR = effectiveMarkup.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const dealerMarkupDecimalR = dealerMarkupDecimal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const subtotalR = priceR.mul(qtyDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const netProfitDR = subtotalR.mul(dealerMarkupDecimalR).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const customerSubtotalR = subtotalR.add(netProfitDR).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const customerPriceR = qtyDec.gt(0)
      ? customerSubtotalR.div(qtyDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : new Decimal(0);

    const result: CalculatedPieceCombined = {
      ...(pieceDto as any),

      rate: rateR,
      price: priceR,
      netProfit: netProfitR,
      markup: markupR,
      dealerMarkupDecimal: dealerMarkupDecimalR,
      netProfitD: netProfitDR,
      subtotal: subtotalR,
      customerPrice: customerPriceR,
      customerSubtotal: customerSubtotalR,
      dpPosPsf,
      dpNegPsf,
    };

    return result;
  }

  private internalCalculateEstimateTotals(
    pieces: CalculatedPieceCombined[],
    factoryTaxRate: Decimal,
    customerTaxRate: Decimal,
  ): {
    rateT: Prisma.Decimal;
    priceT: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    totalPayable: Prisma.Decimal;
    customerPriceT: Prisma.Decimal;
    customerTaxRate: Prisma.Decimal;
    customerTaxAmount: Prisma.Decimal;
    customerTotalPayable: Prisma.Decimal;
    netProfitD: Prisma.Decimal;
  } {
    const zero = new Decimal(0);

    const totals = pieces.reduce(
      (acc, piece) => {
        const qty = new Decimal(piece.qty || 0);

        acc.rateT = acc.rateT.add(piece.rate.mul(qty));
        acc.priceT = acc.priceT.add(piece.price.mul(qty));

        acc.customerPriceT = acc.customerPriceT.add(piece.customerPrice.mul(qty));

        const dealerProfitPiece = piece.price.mul(piece.dealerMarkupDecimal);
        acc.netProfitD = acc.netProfitD.add(dealerProfitPiece.mul(qty));

        return acc;
      },
      {
        rateT: zero,
        priceT: zero,
        customerPriceT: zero,
        netProfitD: zero,
      } as {
        rateT: Decimal;
        priceT: Decimal;
        customerPriceT: Decimal;
        netProfitD: Decimal;
      },
    );

    const yourNetProfit = totals.priceT.sub(totals.rateT);

    const taxAmount = totals.priceT.mul(factoryTaxRate);
    const totalPayable = totals.priceT.add(taxAmount);

    const customerTaxAmount = totals.customerPriceT.mul(customerTaxRate);
    const customerTotalPayable = totals.customerPriceT.add(customerTaxAmount);

    return {
      rateT: new Prisma.Decimal(totals.rateT.toFixed(2)),
      priceT: new Prisma.Decimal(totals.priceT.toFixed(2)),
      netProfit: new Prisma.Decimal(yourNetProfit.toFixed(2)),

      taxRate: new Prisma.Decimal(factoryTaxRate.toFixed(4)),
      taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
      totalPayable: new Prisma.Decimal(totalPayable.toFixed(2)),

      customerPriceT: new Prisma.Decimal(totals.customerPriceT.toFixed(2)),
      customerTaxRate: new Prisma.Decimal(customerTaxRate.toFixed(4)),
      customerTaxAmount: new Prisma.Decimal(customerTaxAmount.toFixed(2)),
      customerTotalPayable: new Prisma.Decimal(customerTotalPayable.toFixed(2)),

      netProfitD: new Prisma.Decimal(totals.netProfitD.toFixed(2)),
    };
  }

  async previewDimensionValidation(input: {
    idSyst: number;
    idConf: number;
    idCryst: number;
    width: number;
    height: number;
    heightLeft?: number;
    heightRight?: number;
    legHeight?: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
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

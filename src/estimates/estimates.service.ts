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
  Order,
  BrandingType,
  Branding,
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

// ✅ PDF on-the-fly
import puppeteer from 'puppeteer';

// ✅ Logs (EventLog + TempLog)
import { LogsService } from 'src/logs/logs.service';

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
  pieceMuntin: Prisma.PieceMuntinGetPayload<{
    include: {
      pattern: true;
      type: true;
      panels: true;
    };
  }> | null;
};

// ✅ incluimos order para que el front sepa si ya fue ordenado
export type EstimateWithRelations = Estimate & {
  user: User;
  pieces: PieceWithRelations[];
  order?: Order | null;
  status?: EstimateStatus | null; // ✅ tipado real, no any
  branding?: Branding | null; // ✅ ya lo estabas retornando
};

// ✅ vistas de PDF (las 4 de tu UI)
export type PdfView = 'client' | 'dealer_internal' | 'dealer_public' | 'admin';

@Injectable()
export class EstimatesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) { }

  // =====================================================
  // ✅ Audit snapshot helper
  // =====================================================
  private buildEstimateAuditSnapshot(est: any) {
    // comentario en espanol: snapshot "estable" para auditoria (no metemos TODO el objeto gigante)
    return {
      id: est.id,
      number: est.number,
      name: est.name,
      idUser: est.idUser,
      statusId: est.statusId,
      statusName: est.status?.name ?? null,
      orderId: est.order?.id ?? null,

      units: est.units,

      // totales
      rateT: est.rateT ?? null,
      priceT: est.priceT ?? null,
      netProfit: est.netProfit ?? null,
      taxRate: est.taxRate ?? null,
      taxAmount: est.taxAmount ?? null,
      totalPayable: est.totalPayable ?? null,

      customerPriceT: est.customerPriceT ?? null,
      customerTaxRate: est.customerTaxRate ?? null,
      customerTaxAmount: est.customerTaxAmount ?? null,
      customerTotalPayable: est.customerTotalPayable ?? null,

      netProfitD: est.netProfitD ?? null,

      // customer
      customerFirstName: est.customerFirstName ?? null,
      customerLastName: est.customerLastName ?? null,
      customerEmail: est.customerEmail ?? null,
      customerPhone: est.customerPhone ?? null,
      customerStreet: est.customerStreet ?? null,
      customerCity: est.customerCity ?? null,
      customerState: est.customerState ?? null,
      customerPostalCode: est.customerPostalCode ?? null,

      // piezas (resumen)
      pieces: Array.isArray(est.pieces)
        ? est.pieces.map((p: any) => ({
          id: p.id ?? null,
          mark: p.mark ?? null,
          qty: p.qty ?? null,

          // dims
          width: p.width ?? null,
          height: p.height ?? null,
          heightLeft: p.heightLeft ?? null,
          heightRight: p.heightRight ?? null,
          legHeight: p.legHeight ?? null,

          // ids de relaciones
          idProd: p.idProd ?? null,
          idBrand: p.idBrand ?? null,
          idSyst: p.idSyst ?? null,
          idConf: p.idConf ?? null,
          idFC: p.idFC ?? null,
          idCryst: p.idCryst ?? null,
          idTint: p.idTint ?? null,
          idCoat: p.idCoat ?? null,

          // money
          rate: p.rate ?? null,
          price: p.price ?? null,
          subtotal: p.subtotal ?? null,
          netProfit: p.netProfit ?? null,

          dealerMarkup: p.dealerMarkup ?? null,
          netProfitD: p.netProfitD ?? null,

          customerPrice: p.customerPrice ?? null,
          customerSubtotal: p.customerSubtotal ?? null,

          dpPosPsf: p.dpPosPsf ?? null,
          dpNegPsf: p.dpNegPsf ?? null,

          // flags
          privacy: p.privacy ?? null,
          screen: p.screen ?? null,

          muntin:
            p.pieceMuntin
              ? {
                id: p.pieceMuntin.id ?? null,
                patternId: p.pieceMuntin.patternId ?? null,
                patternName: p.pieceMuntin.pattern?.name ?? null,
                typeId: p.pieceMuntin.typeId ?? null,
                typeName: p.pieceMuntin.type?.name ?? null,
                totalLites: p.pieceMuntin.totalLites ?? null,
                panels: Array.isArray(p.pieceMuntin.panels)
                  ? p.pieceMuntin.panels.map((mp: any) => ({
                    id: mp.id ?? null,
                    panelIndex: mp.panelIndex ?? null,
                    panelCode: mp.panelCode ?? null,
                    horizontalLites: mp.horizontalLites ?? null,
                    verticalLites: mp.verticalLites ?? null,
                  }))
                  : [],
              }
              : null,
        }))
        : [],
      piecesCount: Array.isArray(est.pieces) ? est.pieces.length : 0,
    };
  }

  // =====================================================
  // Helpers PDF: permisos por rol
  // =====================================================
  private assertPdfViewAllowed(view: PdfView, roleName: string | null) {
    // comentario en espanol: bloqueamos vistas que no corresponden al rol
    if (roleName === 'client') {
      if (view !== 'client') {
        throw new BadRequestException('Vista no permitida.');
      }
      return;
    }

    if (roleName === 'dealer') {
      if (view !== 'dealer_internal' && view !== 'dealer_public') {
        throw new BadRequestException('Vista no permitida.');
      }
      return;
    }

    if (roleName === 'admin' || roleName === 'operator') {
      // comentario en espanol: admin/operator pueden imprimir todo
      return;
    }

    throw new BadRequestException('Rol no permitido.');
  }

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

  private buildPieceMuntinCreateInput(
    muntin?: CreatePieceDto['muntin'] | UpsertPieceDto['muntin'] | null,
  ) {
    if (!muntin) return undefined;

    const panels = Array.isArray(muntin.panels) ? muntin.panels : [];

    const totalLites = panels.reduce((sum, panel) => {
      const h = Number(panel.horizontalLites || 0);
      const v = Number(panel.verticalLites || 0);
      return sum + h * v;
    }, 0);

    return {
      pattern: { connect: { id: muntin.idPattern } },
      ...(muntin.idType ? { type: { connect: { id: muntin.idType } } } : {}),
      totalLites,
      ...(panels.length > 0
        ? {
          panels: {
            create: panels.map((panel) => ({
              panelIndex: panel.panelIndex,
              panelCode: panel.panelCode,
              horizontalLites: panel.horizontalLites,
              verticalLites: panel.verticalLites,
            })),
          },
        }
        : {}),
    };
  }

  private parseConfigMuntinLayout(layout: unknown): Array<{
    panelIndex: number;
    panelCode: string;
    panelLabel?: string;
  }> {
    if (!Array.isArray(layout)) return [];

    return layout
      .map((item: any) => ({
        panelIndex: Number(item?.panelIndex),
        panelCode: String(item?.panelCode ?? '').trim(),
        ...(item?.panelLabel ? { panelLabel: String(item.panelLabel) } : {}),
      }))
      .filter(
        (item) =>
          Number.isInteger(item.panelIndex) &&
          item.panelIndex >= 0 &&
          item.panelCode.length > 0,
      )
      .sort((a, b) => a.panelIndex - b.panelIndex);
  }

  private buildDefaultPanelsFromConfigLayout(
    configLayout: Array<{ panelIndex: number; panelCode: string; panelLabel?: string }>,
    incomingPanels?: Array<{
      panelIndex?: number;
      panelCode?: string;
      horizontalLites?: number;
      verticalLites?: number;
    }>,
  ) {
    const incomingByIndex = new Map<number, (typeof incomingPanels)[number]>();

    for (const panel of incomingPanels ?? []) {
      const idx = Number(panel?.panelIndex);
      if (Number.isInteger(idx) && idx >= 0) {
        incomingByIndex.set(idx, panel);
      }
    }

    return configLayout.map((panel) => {
      const incoming = incomingByIndex.get(panel.panelIndex);

      return {
        panelIndex: panel.panelIndex,
        panelCode: panel.panelCode,
        horizontalLites: Math.max(1, Number(incoming?.horizontalLites ?? 1)),
        verticalLites: Math.max(1, Number(incoming?.verticalLites ?? 1)),
      };
    });
  }

  private async normalizePieceMuntinFromCatalog(
    muntin: CreatePieceDto['muntin'] | UpsertPieceDto['muntin'] | null | undefined,
    configLayoutRaw: unknown,
    tx: PrismaTransactionClient,
  ) {
    if (!muntin) return null;

    const pattern = await tx.muntinPattern.findUnique({
      where: { id: muntin.idPattern },
      select: {
        id: true,
        requiresLites: true,
      },
    });

    if (!pattern) {
      throw new BadRequestException(`Muntin pattern #${muntin.idPattern} not found.`);
    }

    if (muntin.idType) {
      const type = await tx.muntinType.findUnique({
        where: { id: muntin.idType },
        select: { id: true },
      });

      if (!type) {
        throw new BadRequestException(`Muntin type #${muntin.idType} not found.`);
      }
    }

    const configLayout = this.parseConfigMuntinLayout(configLayoutRaw);

    // Full View o cualquier pattern sin lites
    if (!pattern.requiresLites) {
      return {
        idPattern: muntin.idPattern,
        idType: muntin.idType ?? null,
        panels: [],
      };
    }

    // Si requiere lites, la config debe definir layout
    if (configLayout.length === 0) {
      throw new BadRequestException(
        'This configuration does not define a muntin layout.',
      );
    }

    return {
      idPattern: muntin.idPattern,
      idType: muntin.idType ?? null,
      panels: this.buildDefaultPanelsFromConfigLayout(
        configLayout,
        Array.isArray(muntin.panels) ? muntin.panels : [],
      ),
    };
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
      muntin: calculated.muntin ?? null,
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

  // =====================================================
  // BRANDING para reporte (dealer usa su branding, si no company)
  // =====================================================
  private async resolveBrandingForEstimate(
    estimate: any,
    tx: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    const roleName = estimate?.user?.role?.name ?? null;

    // ✅ dealer => branding propio
    if (roleName === 'dealer') {
      const dealerId = estimate?.idUser;
      if (!Number.isFinite(dealerId)) return null;

      return (tx as any).branding.findFirst({
        where: {
          type: BrandingType.DEALER,
          userId: dealerId,
          isActive: true,
        },
      });
    }

    // ✅ resto => company
    return (tx as any).branding.findFirst({
      where: {
        type: BrandingType.COMPANY,
        isActive: true,
      },
    });
  }

  // --- estimate (Get Single) ---
  async estimate(
    where: Prisma.EstimateWhereUniqueInput,
  ): Promise<EstimateWithRelations | null> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: {
        user: { include: { role: true } }, // ✅ NECESARIO para saber si es dealer
        status: true,
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
            pieceMuntin: {
              include: {
                pattern: true,
                type: true,
                panels: {
                  orderBy: { panelIndex: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!estimate) return null;

    const branding = await this.resolveBrandingForEstimate(
      estimate,
      this.prisma as PrismaTransactionClient,
    );

    return { ...(estimate as any), branding } as EstimateWithRelations;
  }

  // --- estimates (Get List) ---
  async estimates(params: {
    where?: Prisma.EstimateWhereInput;
  }): Promise<EstimateWithRelations[]> {
    const estimates = await this.prisma.estimate.findMany({
      where: params.where,
      include: {
        user: true,
        status: true,
        order: true,
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
        const pieceMuntinCreate = this.buildPieceMuntinCreateInput(p.muntin);

        const dataForPrisma: Prisma.PieceCreateWithoutEstimInput = {
          mark: p.mark,
          privacy: p.privacy,
          screen: p.screen,
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
          ...(pieceMuntinCreate
            ? {
              pieceMuntin: {
                create: pieceMuntinCreate,
              },
            }
            : {}),
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
              pieceMuntin: {
                include: {
                  pattern: true,
                  type: true,
                  panels: {
                    orderBy: { panelIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });

      // ✅ EventLog + TempLog (tu LogsService nuevo)
      await this.logs.log({
        action: 'CREATE',
        entityType: 'Estimate',
        entityId: createdEstimate.id,
        userId,
        message: `Estimate created (#${createdEstimate.number})`,
        before: null,
        after: this.buildEstimateAuditSnapshot(createdEstimate),
        meta: { source: 'EstimatesService.createEstimate' },
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

      // 1 sola query: sirve para validar y para snapshot BEFORE
      const beforeEstimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          user: true,
          status: true,
          order: true,
          pieces: {
            orderBy: { id: 'asc' },
            include: {
              pieceMuntin: {
                include: {
                  pattern: true,
                  type: true,
                  panels: {
                    orderBy: { panelIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });

      if (!beforeEstimate || beforeEstimate.idUser !== userId) {
        throw new NotFoundException(`Estimate #${estimateId} not found/denied.`);
      }

      if (beforeEstimate.status?.name !== 'Active') {
        throw new BadRequestException(
          `Estimate #${estimateId} no se puede editar (status: ${beforeEstimate.status?.name ?? 'UNKNOWN'}).`,
        );
      }

      if (beforeEstimate.order) {
        throw new BadRequestException(
          `Estimate #${estimateId} ya tiene una orden y no se puede editar.`,
        );
      }

      const {
        pieces: pieceDtos = [],
        customerTaxRate: rawCustomerTaxRate,
        ...estimateHeaderData
      } = dto;

      const customerTaxRate = new Decimal(
        rawCustomerTaxRate ?? Number(beforeEstimate.customerTaxRate ?? 0),
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
              pieceMuntin: {
                include: {
                  pattern: true,
                  type: true,
                  panels: {
                    orderBy: { panelIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });

      const existingCalculatedById = new Map<number, CalculatedPieceCombined>();
      const newCalculatedQueue: CalculatedPieceCombined[] = [];

      for (const cp of calculatedPieces) {
        const cpId = (cp as UpsertPieceDto).id;

        if (cpId) {
          existingCalculatedById.set(cpId, cp);
        } else {
          newCalculatedQueue.push(cp);
        }
      }

      for (const piece of updatedEstimate.pieces) {
        let sourcePiece = existingCalculatedById.get(piece.id);

        if (!sourcePiece) {
          sourcePiece = newCalculatedQueue.shift();
        }

        if (!sourcePiece) continue;

        await tx.pieceMuntin.deleteMany({
          where: { pieceId: piece.id },
        });

        if (!sourcePiece.muntin) {
          continue;
        }

        const muntinCreate = this.buildPieceMuntinCreateInput(sourcePiece.muntin);

        if (!muntinCreate) continue;

        await tx.pieceMuntin.create({
          data: {
            piece: { connect: { id: piece.id } },
            pattern: { connect: { id: sourcePiece.muntin.idPattern } },
            ...(sourcePiece.muntin.idType
              ? { type: { connect: { id: sourcePiece.muntin.idType } } }
              : {}),
            totalLites: muntinCreate.totalLites,
            ...(sourcePiece.muntin.panels.length > 0
              ? {
                panels: {
                  create: sourcePiece.muntin.panels.map((panel) => ({
                    panelIndex: panel.panelIndex,
                    panelCode: panel.panelCode,
                    horizontalLites: panel.horizontalLites,
                    verticalLites: panel.verticalLites,
                  })),
                },
              }
              : {}),
          },
        });
      }

      const refreshedEstimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          user: true,
          status: true,
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
              pieceMuntin: {
                include: {
                  pattern: true,
                  type: true,
                  panels: {
                    orderBy: { panelIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });

      if (!refreshedEstimate) {
        throw new NotFoundException(`Estimate #${estimateId} not found after update.`);
      }

      // EventLog + TempLog (tu LogsService nuevo)
      await this.logs.log({
        action: 'UPDATE',
        entityType: 'Estimate',
        entityId: refreshedEstimate.id,
        userId,
        message: `Estimate updated (#${refreshedEstimate.number})`,
        before: this.buildEstimateAuditSnapshot(beforeEstimate),
        after: this.buildEstimateAuditSnapshot(refreshedEstimate),
        meta: { source: 'EstimatesService.updateEstimate' },
      });

      return refreshedEstimate;
    });

    return result as EstimateWithRelations;
  }

  // --- deleteEstimate ---
  async deleteEstimate(
    where: Prisma.EstimateWhereUniqueInput,
    userId: number,
  ): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where,
        include: {
          status: true,
          order: true,
          pieces: { orderBy: { id: 'asc' } },
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
        throw new BadRequestException(
          `Estimate #${where.id} ya tiene una orden y no se puede borrar.`,
        );
      }

      const beforeSnapshot = this.buildEstimateAuditSnapshot(estimate);

      await tx.piece.deleteMany({ where: { idEst: where.id } });
      await tx.estimate.delete({ where: { id: where.id } });

      // ✅ EventLog + TempLog (tu LogsService nuevo)
      await this.logs.log({
        action: 'DELETE',
        entityType: 'Estimate',
        entityId: estimate.id,
        userId,
        message: `Estimate deleted (#${estimate.number})`,
        before: beforeSnapshot,
        after: null,
        meta: { source: 'EstimatesService.deleteEstimate' },
      });

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
        muntinLayout: true,
      },
    });

    if (!config) {
      throw new NotFoundException(`Config ID #${pieceDto.idConf} not found.`);
    }

    // comentario en espanol: validamos que la config realmente pertenezca al system
    // y leemos allowScreen desde SysConf
    const sysConf = await tx.sysConf.findUnique({
      where: {
        idSystem_idConfig: {
          idSystem: pieceDto.idSyst,
          idConfig: pieceDto.idConf,
        },
      },
      select: {
        allowScreen: true,

        activeOptions: {
          select: { optionId: true },
        },
        preparationOptions: {
          select: { optionId: true },
        },
        sillOptions: {
          select: { optionId: true },
        },
        reinforcementOptions: {
          select: { optionId: true },
        },
      },
    });

    if (!sysConf) {
      throw new BadRequestException(
        'The selected configuration does not belong to the selected system.',
      );
    }

    // comentario en espanol: screen solo se permite si SysConf.allowScreen = true
    if (pieceDto.screen && !sysConf.allowScreen) {
      throw new BadRequestException(
        'Screen is not allowed for the selected configuration.',
      );
    }

    const allowedActiveOptionIds = new Set(
      sysConf.activeOptions.map((x) => x.optionId),
    );

    const allowedPreparationOptionIds = new Set(
      sysConf.preparationOptions.map((x) => x.optionId),
    );

    const allowedSillOptionIds = new Set(
      sysConf.sillOptions.map((x) => x.optionId),
    );

    const allowedReinforcementOptionIds = new Set(
      sysConf.reinforcementOptions.map((x) => x.optionId),
    );

    const validateSingleSysConfOption = (
      label: string,
      selectedId: number | undefined | null,
      allowedIds: Set<number>,
    ) => {      
      // si este SysConf no tiene opciones para ese campo, no permitimos que manden un valor      
      if (allowedIds.size === 0) {
        if (selectedId != null) {
          throw new BadRequestException(
            `${label} is not allowed for the selected configuration.`,
          );
        }
        return;
      }

      // si el SysConf si tiene opciones configuradas, exigimos que el usuario seleccione una valida      
      if (selectedId == null) {
        throw new BadRequestException(
          `${label} is required for the selected configuration.`,
        );
      }

      if (!allowedIds.has(selectedId)) {
        throw new BadRequestException(
          `${label} is invalid for the selected configuration.`,
        );
      }
    };

    validateSingleSysConfOption(
      'Active option',
      pieceDto.idActiveOption,
      allowedActiveOptionIds,
    );

    validateSingleSysConfOption(
      'Preparation option',
      pieceDto.idPreparationOption,
      allowedPreparationOptionIds,
    );

    validateSingleSysConfOption(
      'Sill option',
      pieceDto.idSillOption,
      allowedSillOptionIds,
    );

    validateSingleSysConfOption(
      'Reinforcement option',
      pieceDto.idReinforcementOption,
      allowedReinforcementOptionIds,
    );

    const normalizedMuntin = await this.normalizePieceMuntinFromCatalog(
      pieceDto.muntin,
      config.muntinLayout,
      tx,
    );

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
      muntin: normalizedMuntin,

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

  // =====================================================
  // ✅ PDF on-the-fly (Buffer) con 4 vistas
  // =====================================================
  async generateEstimatePdfBufferForUser(
    estimateId: number,
    user: AuthUser,
    view: PdfView,
  ): Promise<Buffer> {
    // comentario en espanol: respetamos la misma regla de acceso que findOneForUser
    const estimate = await this.findOneForUser(estimateId, user);

    const viewerRole =
      (user as any)?.role?.name ??
      (user as any)?.roleName ??
      (estimate as any)?.user?.role?.name ??
      null;

    // comentario en espanol: valida que esa vista sea permitida para el rol
    this.assertPdfViewAllowed(view, viewerRole);

    const html = this.buildEstimatePdfHtml(estimate, view);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();

      // comentario en espanol: si el logoUrl es externo, esto ayuda a que cargue completo
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        format: 'Letter',
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        // ✅ ahora SI se nota el margen, porque no lo anulamos en CSS
        margin: {
          top: '24mm',
          right: '16mm',
          bottom: '12mm',
          left: '16mm',
        },
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  // =====================================================
  // ✅ HTML del PDF basado en tus 4 vistas reales
  // =====================================================
  private buildEstimatePdfHtml(
    estimate: EstimateWithRelations,
    view: PdfView,
  ): string {
    const b = (estimate as any).branding as Branding | null;

    const brandingName = b?.name ?? 'Impact Plus';
    const addressLine =
      b?.street || b?.city || b?.state || b?.postalCode
        ? [b?.street, b?.city, b?.state, b?.postalCode].filter(Boolean).join(', ')
        : '';

    const esc = (v: any) =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

    const money = (n: any) => {
      const v = Number(n) || 0;
      return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    };

    const dateLabel = (() => {
      try {
        const d = new Date((estimate as any).date);
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      } catch {
        return '';
      }
    })();

    const logo = b?.logoUrl
      ? `<div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
           <img src="${esc(b.logoUrl)}" style="height:48px; object-fit:contain;" />
         </div>`
      : '';

    // =====================================================
    // ✅ lógica igual a tu frontend (admin => base view depende del owner)
    // =====================================================

    // comentario en espanol: rol del duenio del estimate (quien lo creo)
    const ownerRole = String((estimate as any)?.user?.role?.name ?? '')
      .trim()
      .toLowerCase();

    // comentario en espanol: si admin imprime, el "base view" depende del owner
    const effectiveView: PdfView =
      view === 'admin' ? (ownerRole === 'dealer' ? 'dealer_internal' : 'client') : view;

    const isPublic = effectiveView === 'dealer_public';

    // DealerSummary solo cuando base view es dealer_internal
    const showDealerSummary = effectiveView === 'dealer_internal';

    // AdminSummary solo cuando la vista solicitada es admin
    const showAdminSummary = view === 'admin';

    // =====================================================
    // ✅ Helpers de descripcion (igual a PieceDescriptionCell)
    // =====================================================

    // comentario en espanol: formatea pulgadas en pasos de 1/8 como "60 3/8"
    const formatInchesFromEighthStep = (raw: any) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return '?';

      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);

      const whole = Math.floor(abs);
      const frac = abs - whole;

      // redondeo a octavos
      let eighths = Math.round(frac * 8);

      // carry si se fue a 8/8
      let w = whole;
      if (eighths >= 8) {
        w += 1;
        eighths = 0;
      }

      if (eighths === 0) return `${sign}${w}`;

      const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
      const g = gcd(eighths, 8);
      const num = eighths / g;
      const den = 8 / g;

      return w > 0 ? `${sign}${w} ${num}/${den}` : `${sign}${num}/${den}`;
    };

    // comentario en espanol: formatea PSF como "+70.0 -80.0"
    const formatPsf = (raw: any) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return '';
      const s = n >= 0 ? '+' : '';
      return `${s}${n.toFixed(1)}`;
    };

    // comentario en espanol: construye lineas tipo frontend (PieceDescriptionCell)
    const buildPieceDescriptionLines = (p: any): string[] => {
      const header = [p.prod?.name, p.bran?.name, p.syst?.name, p.conf?.conf]
        .filter(Boolean)
        .join(' ');

      const w = p.width != null ? formatInchesFromEighthStep(p.width) : '?';
      const h = p.height != null ? formatInchesFromEighthStep(p.height) : '?';

      const sizeParts: string[] = [`${w} x ${h}`];

      if (p.heightLeft != null) sizeParts.push(`HL ${formatInchesFromEighthStep(p.heightLeft)}`);
      if (p.heightRight != null) sizeParts.push(`HR ${formatInchesFromEighthStep(p.heightRight)}`);
      if (p.legHeight != null) sizeParts.push(`Leg ${formatInchesFromEighthStep(p.legHeight)}`);

      const sizeLine = `Size: ${sizeParts.join(' / ')}`;

      const glassTokens: string[] = [];
      if (p.cryst?.glass) glassTokens.push(p.cryst.glass);
      if (p.tin?.color) glassTokens.push(p.tin.color);
      if (p.coat?.name) glassTokens.push(p.coat.name);

      const glassLine = glassTokens.length ? `Glass: ${glassTokens.join(' + ')}` : '';

      const optionsLine = [
        `Screen: ${p.screen ? 'Yes' : 'No'}`,
        `Muntin: ${p.pieceMuntin ? 'Yes' : 'No'}`,
        `Privacy: ${p.privacy ? 'Yes' : 'No'}`,
      ].join(' | ');

      const pos = p.dpPosPsf;
      const neg = p.dpNegPsf;
      const psfLine = pos != null && neg != null ? `PSF: ${formatPsf(pos)} ${formatPsf(neg)}` : '';

      return [header, sizeLine, glassLine, optionsLine, psfLine].filter(
        (l) => l && l.trim() !== '',
      );
    };

    // =====================================================
    // ✅ tabla de piezas segun vista (dealer_public usa customerPrice)
    // =====================================================

    const getUnitPrice = (p: any) => {
      if (effectiveView === 'dealer_public') return Number(p.customerPrice ?? p.price) || 0;
      return Number(p.price) || 0;
    };

    const getSubtotal = (p: any) => {
      if (effectiveView === 'dealer_public') {
        const unit = getUnitPrice(p);
        const qty = Number(p.qty) || 0;
        return unit * qty;
      }
      // comentario en espanol: en vistas internas ya viene subtotal calculado por backend
      return Number(p.subtotal ?? 0) || 0;
    };

    const rows = (estimate.pieces ?? [])
      .map((p: any) => {
        const lines = buildPieceDescriptionLines(p);

        const unitPrice = getUnitPrice(p);
        const qty = Number(p.qty) || 0;
        const subtotal = getSubtotal(p);

        const descHtml = lines
          .map((line, idx) =>
            idx === 0 ? `<div class="h">${esc(line)}</div>` : `<div class="s">${esc(line)}</div>`,
          )
          .join('');

        return `
          <tr>
            <td class="td mark">${esc(p.mark)}</td>
            <td class="td desc">
              ${descHtml}
            </td>
            <td class="td center">${esc(qty)}</td>
            <td class="td right">${money(unitPrice)}</td>
            <td class="td right strong">${money(subtotal)}</td>
          </tr>
        `;
      })
      .join('');

    // =====================================================
    // ✅ totales segun vista (igual que TotalsPublic / TotalsInternal)
    // =====================================================

    const subtotalInternal = Number((estimate as any).priceT ?? 0) || 0;
    const taxRate = Number((estimate as any).taxRate ?? 0) || 0;
    const taxAmount = Number((estimate as any).taxAmount ?? 0) || 0;
    const totalPayable = Number((estimate as any).totalPayable ?? 0) || 0;

    const customerSubtotal = Number((estimate as any).customerPriceT ?? 0) || 0;
    const customerTaxRate = Number((estimate as any).customerTaxRate ?? 0) || 0;
    const customerTaxAmount = Number((estimate as any).customerTaxAmount ?? 0) || 0;
    const customerTotal = Number((estimate as any).customerTotalPayable ?? 0) || 0;

    // Dealer summary (como tu DealerSummary)
    const dealerTotalDueToImpact = totalPayable;
    const dealerFinalPriceCustomer = customerSubtotal;
    const dealerProfit = Number((estimate as any).netProfitD ?? 0) || 0;

    // Admin summary (como tu AdminSummary)
    const adminRateT = Number((estimate as any).rateT ?? 0) || 0;
    const adminPriceT = subtotalInternal;
    const adminProfit = Number((estimate as any).netProfit ?? 0) || 0;

    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Estimate ${esc((estimate as any).number)}</title>
  <style>
    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      font-family: Arial, Helvetica, sans-serif;
      color: #111;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 10px;
      border-bottom: 1px solid #e5e7eb;
    }

    .title { font-size: 26px; font-weight: 700; margin: 0; }
    .muted { color: #6b7280; font-size: 12px; margin-top: 6px; }

    .brand { text-align: right; font-size: 12px; color: #6b7280; }
    .brand .name { font-size: 18px; font-weight: 700; color: #374151; margin-top: 6px; }

    .grid {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-top: 12px;
    }

    .label {
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #6b7280;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .value { font-size: 16px; font-weight: 700; color: #111827; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }

    thead th {
      background: #f9fafb;
      font-size: 11px;
      text-transform: uppercase;
      color: #374151;
      padding: 9px 10px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }

    .td {
      padding: 10px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
      font-size: 12px;
    }

    .center { text-align: center; }
    .right { text-align: right; }
    .strong { font-weight: 700; }

    .h { font-weight: 700; color: #111827; font-size: 12px; }
    .s { color: #6b7280; font-size: 11px; margin-top: 4px; line-height: 1.35; }

    .totals { display: flex; justify-content: flex-end; margin-top: 10px; }
    .totbox { min-width: 300px; }

    .sectionTitle {
      font-size: 12px;
      font-weight: 700;
      color: #374151;
      margin: 0 0 6px 0;
    }

    .line {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12px;
      color: #374151;
    }

    .line.total {
      border-top: 2px solid #e5e7eb;
      padding-top: 8px;
      font-size: 14px;
      font-weight: 800;
      color: #111827;
    }

    .summary {
      margin-top: 14px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #f9fafb;
      font-size: 12px;
      color: #374151;
    }

    .summary h3 {
      margin: 0 0 10px 0;
      font-size: 14px;
      font-weight: 800;
      color: #111827;
    }

    .summary .row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-top: 1px solid #e5e7eb;
    }

    .summary .row:first-of-type { border-top: none; padding-top: 0; }

    .summary .profit {
      font-weight: 900;
      color: #065f46;
    }

    .summary .adminprofit {
      font-weight: 900;
      color: #991b1b;
    }

    .footer {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      font-size: 10px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div>
    <div class="header">
      <div>
        <h1 class="title">Estimate</h1>
        <div class="muted">Number: ${esc((estimate as any).number)}</div>
      </div>

      <div class="brand">
        ${logo}
        <div class="name">${esc(brandingName)}</div>
        ${addressLine ? `<div>${esc(addressLine)}</div>` : ``}
        ${b?.email ? `<div>${esc(b.email)}</div>` : ``}
        ${b?.phone ? `<div>${esc(b.phone)}</div>` : ``}
        ${b?.website ? `<div>${esc(b.website)}</div>` : ``}
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="label">Prepared For</div>
        <div class="value">${esc((estimate as any).name)}</div>
      </div>
      <div style="text-align:right;">
        <div class="muted">Date: ${esc(dateLabel)}</div>
      </div>
    </div>

    <div style="margin-top:16px; font-weight:700; color:#111827;">Pieces Detail</div>

    <table>
      <thead>
        <tr>
          <th style="width:80px;">Mark</th>
          <th>Description</th>
          <th style="width:70px; text-align:center;">Qty</th>
          <th style="width:120px; text-align:right;">Unit Price</th>
          <th style="width:120px; text-align:right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="totals">
      <div class="totbox">
        ${isPublic
        ? `
              <div class="line">
                <span>Subtotal:</span>
                <span>${money(customerSubtotal)}</span>
              </div>
              <div class="line">
                <span>Sales Tax (${(customerTaxRate * 100).toFixed(2)}%):</span>
                <span>${money(customerTaxAmount)}</span>
              </div>
              <div class="line total">
                <span>Total:</span>
                <span>${money(customerTotal)}</span>
              </div>
            `
        : effectiveView === 'dealer_internal'
          ? `
                <div class="sectionTitle">Customer View Total</div>
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(customerSubtotal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(customerTaxRate * 100).toFixed(2)}%):</span>
                  <span>${money(customerTaxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(customerTotal)}</span>
                </div>

                <div style="height:14px;"></div>

                <div class="sectionTitle">Internal Totals</div>
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(subtotalInternal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(taxRate * 100).toFixed(2)}%):</span>
                  <span>${money(taxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(totalPayable)}</span>
                </div>
              `
          : `
                <div class="line">
                  <span>Subtotal:</span>
                  <span>${money(subtotalInternal)}</span>
                </div>
                <div class="line">
                  <span>Sales Tax (${(taxRate * 100).toFixed(2)}%):</span>
                  <span>${money(taxAmount)}</span>
                </div>
                <div class="line total">
                  <span>Total:</span>
                  <span>${money(totalPayable)}</span>
                </div>
              `
      }
      </div>
    </div>

    ${showDealerSummary
        ? `
          <div class="summary" style="background:#ecfdf5; border-color:#bbf7d0;">
            <h3 style="color:#065f46;">Dealer Summary</h3>
            <div class="row"><span>Total Due to Impact Plus:</span><span>${money(dealerTotalDueToImpact)}</span></div>
            <div class="row"><span>Final Price for Your Customer:</span><span>${money(dealerFinalPriceCustomer)}</span></div>
            <div class="row"><span>Your Profit (Net Profit):</span><span class="profit">${money(dealerProfit)}</span></div>
          </div>
        `
        : ''
      }

    ${showAdminSummary
        ? `
          <div class="summary" style="background:#fef2f2; border-color:#fecaca;">
            <h3 style="color:#991b1b;">Admin Summary</h3>
            <div class="row"><span>Total Production Cost (Rate):</span><span>${money(adminRateT)}</span></div>
            <div class="row"><span>Sale Price (Before Taxes):</span><span>${money(adminPriceT)}</span></div>
            <div class="row"><span>Impact Plus Profit (Net Profit):</span><span class="adminprofit">${money(adminProfit)}</span></div>
          </div>
        `
        : ''
      }

    <div class="footer">
      This estimate is valid for 30 days. Thank you for your business.
    </div>
  </div>
</body>
</html>
    `;
  }
}

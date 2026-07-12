// @/estimates/estimates.service.ts
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
import { PrismaService } from '@/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import {
  CreateEstimateHeaderDto,
  UpdateEstimateHeaderDto,
} from './dto/estimate-header.dto';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';

// --- Importación Estándar ---
import Decimal from 'decimal.js';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import { EstimatePdfService } from './pdf/estimate-pdf.service';
import { EstimateDimensionValidationService } from './dimensions/estimate-dimension-validation.service';
import { EstimateMuntinService } from './muntins/estimate-muntin.service';
import {
  EstimatePieceCalculatorService,
  type CalculatedPieceCombined,
} from './calculation/estimate-piece-calculator.service';
import { EstimateAuditSnapshotBuilder } from './audit/estimate-audit-snapshot.builder';

// Logs (EventLog + TempLog)
import { LogsService } from '@/logs/logs.service';
// Cron Jobs
import { Cron, CronExpression } from '@nestjs/schedule';

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






// --- Tipos con Relaciones (para salida final) ---
type PieceWithRelations = Piece & {
  prod: Prisma.ProductGetPayload<{}>;
  bran: Prisma.BrandGetPayload<{}>;
  syst: Prisma.SystemGetPayload<{}>;
  conf: Prisma.ConfigGetPayload<{
    include: {
      category: true;
    };
  }>;
  fColor: Prisma.FrameColorGetPayload<{}>;
  cryst: Prisma.CrystalGetPayload<{}> | null;
  tin: Prisma.TintGetPayload<{}> | null;
  coat: Prisma.CoatingGetPayload<{}> | null;

  activeOption: Prisma.ActiveOptionGetPayload<{}> | null;
  preparationOption: Prisma.PreparationOptionGetPayload<{}> | null;
  sillOption: Prisma.SillOptionGetPayload<{}> | null;
  reinforcementOption: Prisma.ReinforcementOptionGetPayload<{}> | null;

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
    private estimatePdfService: EstimatePdfService,
    private dimensionValidationService: EstimateDimensionValidationService,
    private pieceCalculator: EstimatePieceCalculatorService,
    private muntinService: EstimateMuntinService,
  ) { }

  private decimalOrNull(value: string | number | null | undefined) {
    return value == null || value === '' ? null : new Prisma.Decimal(value);
  }

  private intOrNull(value: number | string | null | undefined) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  private jsonArrayOrNull(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (!Array.isArray(value)) return Prisma.JsonNull;

    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item)) as Prisma.InputJsonValue;
  }

  /**
 * Convierte una pieza ya calculada en los campos escalares
 * que se almacenan en Piece.
 *
 * No incluye idEst ni PieceMuntin.
 */
  private buildCalculatedPiecePersistenceData(
    piece: CalculatedPieceCombined,
  ): Omit<Prisma.PieceUncheckedCreateInput, 'idEst'> {
    return {
      mark: piece.mark,
      privacy: piece.privacy ?? false,
      screen: piece.screen ?? false,
      highBottom: piece.highBottom ?? false,
      highBottomPercent: piece.highBottomPercent
        ? new Prisma.Decimal(piece.highBottomPercent.toFixed(4))
        : null,

      qty: piece.qty,

      idActiveOption: piece.idActiveOption ?? null,
      idPreparationOption: piece.idPreparationOption ?? null,
      idSillOption: piece.idSillOption ?? null,
      idReinforcementOption: piece.idReinforcementOption ?? null,

      rate: new Prisma.Decimal(piece.rate.toFixed(2)),
      price: new Prisma.Decimal(piece.price.toFixed(2)),
      markup: new Prisma.Decimal(piece.markup.toFixed(4)),
      subtotal: new Prisma.Decimal(piece.subtotal.toFixed(2)),
      dealerMarkup: new Prisma.Decimal(
        piece.dealerMarkupDecimal.toFixed(4),
      ),
      netProfit: new Prisma.Decimal(piece.netProfit.toFixed(2)),
      netProfitD: new Prisma.Decimal(piece.netProfitD.toFixed(2)),
      customerPrice: new Prisma.Decimal(
        piece.customerPrice.toFixed(2),
      ),
      customerSubtotal: new Prisma.Decimal(
        piece.customerSubtotal.toFixed(2),
      ),

      width: this.decimalOrNull(piece.width),
      height: this.decimalOrNull(piece.height),
      heightLeft: this.decimalOrNull(piece.heightLeft),
      heightRight: this.decimalOrNull(piece.heightRight),
      legHeight: this.decimalOrNull(piece.legHeight),
      sashHeight: this.decimalOrNull((piece as any).sashHeight),
      windowHeight: this.decimalOrNull((piece as any).windowHeight),

      doorWidth: this.decimalOrNull((piece as any).doorWidth),
      doorHeight: this.decimalOrNull((piece as any).doorHeight),
      leftSideliteWidth: this.decimalOrNull(
        (piece as any).leftSideliteWidth,
      ),
      rightSideliteWidth: this.decimalOrNull(
        (piece as any).rightSideliteWidth,
      ),

      leftPanels: this.intOrNull((piece as any).leftPanels),
      rightPanels: this.intOrNull((piece as any).rightPanels),
      panelCount: this.intOrNull((piece as any).panelCount),
      horizontalHeights: this.jsonArrayOrNull(
        (piece as any).horizontalHeights,
      ),

      idProd: piece.idProd,
      idBrand: piece.idBrand,
      idSyst: piece.idSyst,
      idConf: piece.idConf,
      idFC: piece.idFC,
      idCryst: piece.idCryst ?? null,
      idTint: piece.idTint ?? null,
      idCoat: piece.idCoat ?? null,

      dpPosPsf: new Prisma.Decimal(piece.dpPosPsf.toFixed(2)),
      dpNegPsf: new Prisma.Decimal(piece.dpNegPsf.toFixed(2)),
    };
  }

  /**
 * Elimina el muntin anterior de una pieza y crea el nuevo,
 * cuando la pieza calculada contiene configuración de muntin.
 */
  private async replacePieceMuntin(
    tx: PrismaTransactionClient,
    pieceId: number,
    muntin: CalculatedPieceCombined['muntin'],
  ): Promise<void> {
    await tx.pieceMuntin.deleteMany({
      where: { pieceId },
    });

    if (!muntin) return;

    const muntinCreate =
      this.muntinService.buildPieceMuntinCreateInput(muntin);

    if (!muntinCreate) return;

    await tx.pieceMuntin.create({
      data: {
        piece: {
          connect: { id: pieceId },
        },
        pattern: {
          connect: { id: muntin.idPattern },
        },
        ...(muntin.idType
          ? {
            type: {
              connect: { id: muntin.idType },
            },
          }
          : {}),
        totalLites: muntinCreate.totalLites,
        ...(muntin.panels.length > 0
          ? {
            panels: {
              create: muntin.panels.map((panel) => ({
                panelIndex: panel.panelIndex,
                panelCode: panel.panelCode ?? null,
                panelLabel: panel.panelLabel,
                horizontalLites: panel.horizontalLites,
                verticalLites: panel.verticalLites,
              })),
            },
          }
          : {}),
      },
    });
  }

  /**
 * Obtiene el Estimate con las mismas relaciones que utiliza
 * la pantalla de edición.
 */
  private async getEstimateWithRelationsInTransaction(
    tx: PrismaTransactionClient,
    estimateId: number,
  ) {
    return tx.estimate.findUnique({
      where: { id: estimateId },
      include: {
        user: {
          include: {
            role: true,
          },
        },
        status: true,
        order: true,
        pieces: {
          orderBy: { id: 'asc' },
          include: {
            prod: true,
            bran: true,
            syst: true,
            conf: {
              include: {
                category: true,
              },
            },
            fColor: true,
            cryst: true,
            tin: true,
            coat: true,

            activeOption: true,
            preparationOption: true,
            sillOption: true,
            reinforcementOption: true,

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
  }

  /**
 * Confirma propiedad, estado editable y ausencia de Order.
 */
  private assertEstimateCanBeEdited(
    estimate: {
      id: number;
      idUser: number;
      status?: {
        name: string;
      } | null;
      order?: {
        id: number;
      } | null;
    } | null,
    estimateId: number,
    userId: number,
  ): void {
    if (!estimate || estimate.idUser !== userId) {
      throw new NotFoundException(
        `Estimate #${estimateId} not found/denied.`,
      );
    }

    if (estimate.status?.name !== 'Active') {
      throw new BadRequestException(
        `Estimate #${estimateId} cannot be edited because its status is ${estimate.status?.name ?? 'UNKNOWN'
        }.`,
      );
    }

    if (estimate.order) {
      throw new BadRequestException(
        `Estimate #${estimateId} already has an order and cannot be edited.`,
      );
    }
  }

  /**
 * Suma las piezas ya guardadas y actualiza los totales
 * del encabezado del Estimate.
 */
  private async updateEstimateTotalsFromPersistedPieces(
    tx: PrismaTransactionClient,
    estimateId: number,
    factoryTaxRate: Decimal,
    customerTaxRate: Decimal,
  ): Promise<void> {
    const persistedPieces = await tx.piece.findMany({
      where: {
        idEst: estimateId,
      },
      select: {
        qty: true,
        rate: true,
        price: true,
        customerPrice: true,
        dealerMarkup: true,
      },
    });

    const estimateTotals =
      this.pieceCalculator.calculateEstimateTotalsFromPersistedPieces(
        persistedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

    const totalUnits = persistedPieces.reduce(
      (sum, piece) => sum + piece.qty,
      0,
    );

    await tx.estimate.update({
      where: {
        id: estimateId,
      },
      data: {
        ...estimateTotals,
        units: totalUnits,
      },
    });
  }

  private async getEstimateExpirationDate(tx: PrismaTransactionClient) {
    const validDaysParam = await tx.globalParameter.findUnique({
      where: { key: GlobalParameterKey.ESTIMATE_VALID_DAYS },
    });

    const validDays = validDaysParam ? Number(validDaysParam.value) : 30;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + validDays);

    return expiresAt;
  }

  private async expireOldActiveEstimates(
    tx: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    const expiredStatus = await (tx as any).estimateStatus.findUnique({
      where: { name: 'Expired' },
      select: { id: true },
    });

    const activeStatus = await (tx as any).estimateStatus.findUnique({
      where: { name: 'Active' },
      select: { id: true },
    });

    if (!expiredStatus || !activeStatus) {
      throw new InternalServerErrorException(
        'EstimateStatus "Active" or "Expired" not seeded.',
      );
    }

    await (tx as any).estimate.updateMany({
      where: {
        statusId: activeStatus.id,
        order: null,
        expiresAt: {
          lt: new Date(),
        },
      },
      data: {
        statusId: expiredStatus.id,
      },
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireOldActiveEstimatesJob() {
    await this.expireOldActiveEstimates();
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
    const cache = this.pieceCalculator.createCalculationCache();
    const calculated: CalculatedPieceCombined =
      await this.pieceCalculator.calculatePieceMetrics(
        pieceDto,
        effectiveMarkupDecimal,
        this.prisma as PrismaTransactionClient,
        cache,
      );

    return {
      ...calculated,
      muntin: calculated.muntin ?? null,
      id: (pieceDto as UpsertPieceDto).id,
      highBottom: calculated.highBottom,
      highBottomPercent: calculated.highBottomPercent
        ? new Prisma.Decimal(calculated.highBottomPercent.toFixed(4))
        : null,
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
            conf: {
              include: {
                category: true,
              },
            },
            fColor: true,
            cryst: true,
            tin: true,
            coat: true,

            activeOption: true,
            preparationOption: true,
            sillOption: true,
            reinforcementOption: true,

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
  }) {
    const estimates = await this.prisma.estimate.findMany({
      where: params.where,
      include: {
        user: {
          include: {
            role: true,
          },
        },
        status: true,
        order: true,
      },
      orderBy: { date: 'desc' },
    });

    return estimates;
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

  // =====================================================
  // NUEVO FLUJO PERSISTENTE
  // =====================================================

  /**
   * Crea inmediatamente un Estimate vacío en DB.
   * Las piezas se agregarán posteriormente una por una.
   */
  async createEmptyEstimate(
    dto: CreateEstimateHeaderDto,
    userId: number,
  ): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isTaxExempt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const taxParameter = await tx.globalParameter.findUnique({
        where: {
          key: GlobalParameterKey.SALES_TAX,
        },
      });

      if (!taxParameter) {
        throw new InternalServerErrorException(
          'SALES_TAX config missing.',
        );
      }

      const activeStatus = await tx.estimateStatus.findUnique({
        where: {
          name: 'Active',
        },
        select: {
          id: true,
        },
      });

      if (!activeStatus) {
        throw new InternalServerErrorException(
          'EstimateStatus "Active" not seeded.',
        );
      }

      const expiresAt = await this.getEstimateExpirationDate(
        tx as PrismaTransactionClient,
      );

      const factoryTaxRate = user.isTaxExempt
        ? new Decimal(0)
        : new Decimal(taxParameter.value.toString());

      const customerTaxRate = new Decimal(
        dto.customerTaxRate ?? 0,
      );

      const estimateTotals =
        this.pieceCalculator.calculateEstimateTotals(
          [],
          factoryTaxRate,
          customerTaxRate,
        );

      const sequence = await tx.estimateSequence.create({
        data: {},
      });

      const nextNumber = String(190909 + sequence.id);

      const createdBase = await tx.estimate.create({
        data: {
          number: nextNumber,
          name: dto.name,
          expiresAt,

          customerFirstName: dto.customerFirstName ?? null,
          customerLastName: dto.customerLastName ?? null,
          customerEmail: dto.customerEmail ?? null,
          customerPhone: dto.customerPhone ?? null,
          customerStreet: dto.customerStreet ?? null,
          customerCity: dto.customerCity ?? null,
          customerState: dto.customerState ?? null,
          customerPostalCode: dto.customerPostalCode ?? null,

          units: 0,

          rateT: estimateTotals.rateT,
          priceT: estimateTotals.priceT,
          netProfit: estimateTotals.netProfit,

          taxRate: estimateTotals.taxRate,
          taxAmount: estimateTotals.taxAmount,
          totalPayable: estimateTotals.totalPayable,

          customerPriceT: estimateTotals.customerPriceT,
          customerTaxRate: estimateTotals.customerTaxRate,
          customerTaxAmount: estimateTotals.customerTaxAmount,
          customerTotalPayable:
            estimateTotals.customerTotalPayable,

          netProfitD: estimateTotals.netProfitD,

          status: {
            connect: {
              id: activeStatus.id,
            },
          },

          user: {
            connect: {
              id: userId,
            },
          },
        },
        select: {
          id: true,
        },
      });

      const createdEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          createdBase.id,
        );

      if (!createdEstimate) {
        throw new InternalServerErrorException(
          'Estimate could not be loaded after creation.',
        );
      }

      await this.logs.log({
        action: 'CREATE',
        entityType: 'Estimate',
        entityId: createdEstimate.id,
        userId,
        message: `Estimate created (#${createdEstimate.number})`,
        before: null,
        after:
          EstimateAuditSnapshotBuilder.build(createdEstimate),
        meta: {
          source: 'EstimatesService.createEmptyEstimate',
        },
      });

      return createdEstimate as EstimateWithRelations;
    });
  }

  /**
   * Actualiza únicamente los datos del encabezado.
   * Nunca crea, actualiza ni elimina piezas.
   */
  async updateEstimateHeader(
    estimateId: number,
    dto: UpdateEstimateHeaderDto,
    userId: number,
  ): Promise<EstimateWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const beforeEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      this.assertEstimateCanBeEdited(
        beforeEstimate,
        estimateId,
        userId,
      );

      const headerData: Prisma.EstimateUpdateInput = {
        ...(dto.name !== undefined
          ? {
            name: dto.name,
          }
          : {}),

        ...(dto.customerFirstName !== undefined
          ? {
            customerFirstName: dto.customerFirstName,
          }
          : {}),

        ...(dto.customerLastName !== undefined
          ? {
            customerLastName: dto.customerLastName,
          }
          : {}),

        ...(dto.customerEmail !== undefined
          ? {
            customerEmail: dto.customerEmail,
          }
          : {}),

        ...(dto.customerPhone !== undefined
          ? {
            customerPhone: dto.customerPhone,
          }
          : {}),

        ...(dto.customerStreet !== undefined
          ? {
            customerStreet: dto.customerStreet,
          }
          : {}),

        ...(dto.customerCity !== undefined
          ? {
            customerCity: dto.customerCity,
          }
          : {}),

        ...(dto.customerState !== undefined
          ? {
            customerState: dto.customerState,
          }
          : {}),

        ...(dto.customerPostalCode !== undefined
          ? {
            customerPostalCode: dto.customerPostalCode,
          }
          : {}),
      };

      if (Object.keys(headerData).length > 0) {
        await tx.estimate.update({
          where: {
            id: estimateId,
          },
          data: headerData,
        });
      }

      const factoryTaxRate = new Decimal(
        beforeEstimate!.taxRate.toString(),
      );

      const customerTaxRate =
        dto.customerTaxRate !== undefined
          ? new Decimal(dto.customerTaxRate)
          : new Decimal(
            beforeEstimate!.customerTaxRate.toString(),
          );

      await this.updateEstimateTotalsFromPersistedPieces(
        tx as PrismaTransactionClient,
        estimateId,
        factoryTaxRate,
        customerTaxRate,
      );

      const updatedEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      if (!updatedEstimate) {
        throw new NotFoundException(
          `Estimate #${estimateId} not found after header update.`,
        );
      }

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'Estimate',
        entityId: updatedEstimate.id,
        userId,
        message: `Estimate header updated (#${updatedEstimate.number})`,
        before:
          EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after:
          EstimateAuditSnapshotBuilder.build(updatedEstimate),
        meta: {
          source: 'EstimatesService.updateEstimateHeader',
        },
      });

      return updatedEstimate as EstimateWithRelations;
    });
  }

  /**
   * Calcula y guarda una pieza nueva.
   * Después actualiza los totales del Estimate.
   */
  async addPieceToEstimate(
    estimateId: number,
    dto: CreatePieceDto,
    userId: number,
  ): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const effectiveMarkupDecimal =
      user.markupOverride !== null
        ? new Decimal(user.markupOverride.toString())
        : new Decimal(user.role.markup.toString());

    return this.prisma.$transaction(async (tx) => {
      const beforeEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      this.assertEstimateCanBeEdited(
        beforeEstimate,
        estimateId,
        userId,
      );

      const cache =
        this.pieceCalculator.createCalculationCache();

      const calculatedPiece =
        await this.pieceCalculator.calculatePieceMetrics(
          dto,
          effectiveMarkupDecimal,
          tx as PrismaTransactionClient,
          cache,
        );

      const pieceData =
        this.buildCalculatedPiecePersistenceData(
          calculatedPiece,
        );

      const createdPiece = await tx.piece.create({
        data: {
          ...pieceData,
          idEst: estimateId,
        },
        select: {
          id: true,
        },
      });

      await this.replacePieceMuntin(
        tx as PrismaTransactionClient,
        createdPiece.id,
        calculatedPiece.muntin,
      );

      const factoryTaxRate = new Decimal(
        beforeEstimate!.taxRate.toString(),
      );

      const customerTaxRate = new Decimal(
        beforeEstimate!.customerTaxRate.toString(),
      );

      await this.updateEstimateTotalsFromPersistedPieces(
        tx as PrismaTransactionClient,
        estimateId,
        factoryTaxRate,
        customerTaxRate,
      );

      const updatedEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      if (!updatedEstimate) {
        throw new NotFoundException(
          `Estimate #${estimateId} not found after adding piece.`,
        );
      }

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'Estimate',
        entityId: updatedEstimate.id,
        userId,
        message: `Piece added to Estimate #${updatedEstimate.number}`,
        before:
          EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after:
          EstimateAuditSnapshotBuilder.build(updatedEstimate),
        meta: {
          source: 'EstimatesService.addPieceToEstimate',
          pieceId: createdPiece.id,
        },
      });

      return updatedEstimate as EstimateWithRelations;
    });
  }

  /**
   * Recalcula y actualiza una pieza existente.
   * Después actualiza los totales del Estimate.
   */
  async updatePieceInEstimate(
    estimateId: number,
    pieceId: number,
    dto: CreatePieceDto,
    userId: number,
  ): Promise<EstimateWithRelations> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const effectiveMarkupDecimal =
      user.markupOverride !== null
        ? new Decimal(user.markupOverride.toString())
        : new Decimal(user.role.markup.toString());

    return this.prisma.$transaction(async (tx) => {
      const beforeEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      this.assertEstimateCanBeEdited(
        beforeEstimate,
        estimateId,
        userId,
      );

      const existingPiece = beforeEstimate!.pieces.find(
        (piece) => piece.id === pieceId,
      );

      if (!existingPiece) {
        throw new NotFoundException(
          `Piece #${pieceId} was not found in Estimate #${estimateId}.`,
        );
      }

      const cache =
        this.pieceCalculator.createCalculationCache();

      const calculatedPiece =
        await this.pieceCalculator.calculatePieceMetrics(
          dto,
          effectiveMarkupDecimal,
          tx as PrismaTransactionClient,
          cache,
        );

      const pieceData =
        this.buildCalculatedPiecePersistenceData(
          calculatedPiece,
        );

      await tx.piece.update({
        where: {
          id: pieceId,
        },
        data: pieceData,
      });

      await this.replacePieceMuntin(
        tx as PrismaTransactionClient,
        pieceId,
        calculatedPiece.muntin,
      );

      const factoryTaxRate = new Decimal(
        beforeEstimate!.taxRate.toString(),
      );

      const customerTaxRate = new Decimal(
        beforeEstimate!.customerTaxRate.toString(),
      );

      await this.updateEstimateTotalsFromPersistedPieces(
        tx as PrismaTransactionClient,
        estimateId,
        factoryTaxRate,
        customerTaxRate,
      );

      const updatedEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      if (!updatedEstimate) {
        throw new NotFoundException(
          `Estimate #${estimateId} not found after updating piece.`,
        );
      }

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'Estimate',
        entityId: updatedEstimate.id,
        userId,
        message: `Piece updated in Estimate #${updatedEstimate.number}`,
        before:
          EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after:
          EstimateAuditSnapshotBuilder.build(updatedEstimate),
        meta: {
          source: 'EstimatesService.updatePieceInEstimate',
          pieceId,
        },
      });

      return updatedEstimate as EstimateWithRelations;
    });
  }

  /**
   * Elimina una pieza existente.
   * PieceMuntin se elimina automáticamente por ON DELETE CASCADE.
   */
  async deletePieceFromEstimate(
    estimateId: number,
    pieceId: number,
    userId: number,
  ): Promise<EstimateWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const beforeEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      this.assertEstimateCanBeEdited(
        beforeEstimate,
        estimateId,
        userId,
      );

      const existingPiece = beforeEstimate!.pieces.find(
        (piece) => piece.id === pieceId,
      );

      if (!existingPiece) {
        throw new NotFoundException(
          `Piece #${pieceId} was not found in Estimate #${estimateId}.`,
        );
      }

      await tx.piece.delete({
        where: {
          id: pieceId,
        },
      });

      const factoryTaxRate = new Decimal(
        beforeEstimate!.taxRate.toString(),
      );

      const customerTaxRate = new Decimal(
        beforeEstimate!.customerTaxRate.toString(),
      );

      await this.updateEstimateTotalsFromPersistedPieces(
        tx as PrismaTransactionClient,
        estimateId,
        factoryTaxRate,
        customerTaxRate,
      );

      const updatedEstimate =
        await this.getEstimateWithRelationsInTransaction(
          tx as PrismaTransactionClient,
          estimateId,
        );

      if (!updatedEstimate) {
        throw new NotFoundException(
          `Estimate #${estimateId} not found after deleting piece.`,
        );
      }

      await this.logs.log({
        action: 'UPDATE',
        entityType: 'Estimate',
        entityId: updatedEstimate.id,
        userId,
        message: `Piece deleted from Estimate #${updatedEstimate.number}`,
        before:
          EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after:
          EstimateAuditSnapshotBuilder.build(updatedEstimate),
        meta: {
          source: 'EstimatesService.deletePieceFromEstimate',
          pieceId,
        },
      });

      return updatedEstimate as EstimateWithRelations;
    });
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

      const expiresAt = await this.getEstimateExpirationDate(
        tx as PrismaTransactionClient,
      );

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

      const seq = await tx.estimateSequence.create({
        data: {},
      });

      const nextNumber = String(190909 + seq.id);

      const {
        pieces: pieceDtos,
        customerTaxRate: _ignoredCustomerTaxRate,
        ...estimateHeaderData
      } = dto;

      const cache = this.pieceCalculator.createCalculationCache();
      const calculatedPieces: CalculatedPieceCombined[] = [];

      for (const p of pieceDtos) {
        const result = await this.pieceCalculator.calculatePieceMetrics(
          p,
          effectiveMarkupDecimal,
          tx as PrismaTransactionClient,
          cache
        );

        calculatedPieces.push(result);
      }

      const estimateTotals = this.pieceCalculator.calculateEstimateTotals(
        calculatedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      const piecesToCreate: Prisma.PieceCreateWithoutEstimInput[] = calculatedPieces.map((p) => {
        const pieceMuntinCreate = this.muntinService.buildPieceMuntinCreateInput(p.muntin);

        const dataForPrisma: Prisma.PieceCreateWithoutEstimInput = {
          mark: p.mark,
          privacy: p.privacy ?? false,
          screen: p.screen ?? false,
          highBottom: p.highBottom ?? false,
          highBottomPercent: p.highBottomPercent
            ? new Prisma.Decimal(p.highBottomPercent.toFixed(4))
            : null,
          qty: p.qty,

          ...(p.idActiveOption
            ? {
              activeOption: {
                connect: { id: p.idActiveOption },
              },
            }
            : {}),

          ...(p.idPreparationOption
            ? {
              preparationOption: {
                connect: { id: p.idPreparationOption },
              },
            }
            : {}),

          ...(p.idSillOption
            ? {
              sillOption: {
                connect: { id: p.idSillOption },
              },
            }
            : {}),

          ...(p.idReinforcementOption
            ? {
              reinforcementOption: {
                connect: { id: p.idReinforcementOption },
              },
            }
            : {}),

          rate: new Prisma.Decimal(p.rate.toFixed(2)),
          price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)),
          subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(2)),
          netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          customerPrice: new Prisma.Decimal(p.customerPrice.toFixed(2)),
          customerSubtotal: new Prisma.Decimal(p.customerSubtotal.toFixed(2)),

          width: this.decimalOrNull(p.width),
          height: this.decimalOrNull(p.height),
          heightLeft: this.decimalOrNull(p.heightLeft),
          heightRight: this.decimalOrNull(p.heightRight),
          legHeight: this.decimalOrNull(p.legHeight),
          sashHeight: this.decimalOrNull((p as any).sashHeight),
          windowHeight: this.decimalOrNull((p as any).windowHeight),

          doorWidth: this.decimalOrNull((p as any).doorWidth),
          doorHeight: this.decimalOrNull((p as any).doorHeight),
          leftSideliteWidth: this.decimalOrNull((p as any).leftSideliteWidth),
          rightSideliteWidth: this.decimalOrNull((p as any).rightSideliteWidth),
          leftPanels: this.intOrNull((p as any).leftPanels),
          rightPanels: this.intOrNull((p as any).rightPanels),
          panelCount: this.intOrNull((p as any).panelCount),
          horizontalHeights: this.jsonArrayOrNull((p as any).horizontalHeights),
          prod: { connect: { id: p.idProd } },
          bran: { connect: { id: p.idBrand } },
          syst: { connect: { id: p.idSyst } },
          conf: { connect: { id: p.idConf } },
          fColor: { connect: { id: p.idFC } },
          ...(p.idCryst
            ? { cryst: { connect: { id: p.idCryst } } }
            : {}),

          ...(p.idTint
            ? { tin: { connect: { id: p.idTint } } }
            : {}),

          ...(p.idCoat
            ? { coat: { connect: { id: p.idCoat } } }
            : {}),

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
        expiresAt,
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
              conf: {
                include: {
                  category: true,
                },
              },
              fColor: true,
              cryst: true,
              tin: true,
              coat: true,

              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,

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
        after: EstimateAuditSnapshotBuilder.build(createdEstimate),
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

      const expiresAt = await this.getEstimateExpirationDate(
        tx as PrismaTransactionClient,
      );

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
              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,
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
          `Estimate #${estimateId} cannot be edited because its status is ${beforeEstimate.status?.name ?? 'UNKNOWN'}.`,
        );
      }

      if (beforeEstimate.order) {
        throw new BadRequestException(
          `Estimate #${estimateId} already has an order and cannot be edited.`,
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
      const cache = this.pieceCalculator.createCalculationCache();
      const calculatedPieces: CalculatedPieceCombined[] = [];

      for (const p of pieceDtos) {
        const result = await this.pieceCalculator.calculatePieceMetrics(
          p,
          effectiveMarkupDecimal,
          tx as PrismaTransactionClient,
          cache
        );

        calculatedPieces.push(result);
      }

      const estimateTotals = this.pieceCalculator.calculateEstimateTotals(
        calculatedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

      const totalUnits = calculatedPieces.reduce((sum, p) => sum + (p.qty || 0), 0);

      const piecesToUpsert = calculatedPieces.map((p) => {
        const upsertData: Omit<Prisma.PieceUncheckedUpdateInput, 'idEst'> &
          Omit<Prisma.PieceUncheckedCreateInput, 'idEst'> = {
          mark: p.mark,
          privacy: p.privacy ?? false,
          screen: p.screen ?? false,
          highBottom: p.highBottom ?? false,
          highBottomPercent: p.highBottomPercent
            ? new Prisma.Decimal(p.highBottomPercent.toFixed(4))
            : null,
          qty: p.qty,

          idActiveOption: p.idActiveOption ?? null,
          idPreparationOption: p.idPreparationOption ?? null,
          idSillOption: p.idSillOption ?? null,
          idReinforcementOption: p.idReinforcementOption ?? null,

          rate: new Prisma.Decimal(p.rate.toFixed(2)),
          price: new Prisma.Decimal(p.price.toFixed(2)),
          markup: new Prisma.Decimal(p.markup.toFixed(4)),
          subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
          dealerMarkup: new Prisma.Decimal(p.dealerMarkupDecimal.toFixed(4)),
          netProfit: new Prisma.Decimal(p.netProfit.toFixed(2)),
          netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
          customerPrice: new Prisma.Decimal(p.customerPrice.toFixed(2)),
          customerSubtotal: new Prisma.Decimal(p.customerSubtotal.toFixed(2)),

          width: this.decimalOrNull(p.width),
          height: this.decimalOrNull(p.height),
          heightLeft: this.decimalOrNull(p.heightLeft),
          heightRight: this.decimalOrNull(p.heightRight),
          legHeight: this.decimalOrNull(p.legHeight),
          sashHeight: this.decimalOrNull((p as any).sashHeight),
          windowHeight: this.decimalOrNull((p as any).windowHeight),

          doorWidth: this.decimalOrNull((p as any).doorWidth),
          doorHeight: this.decimalOrNull((p as any).doorHeight),
          leftSideliteWidth: this.decimalOrNull((p as any).leftSideliteWidth),
          rightSideliteWidth: this.decimalOrNull((p as any).rightSideliteWidth),
          leftPanels: this.intOrNull((p as any).leftPanels),
          rightPanels: this.intOrNull((p as any).rightPanels),
          panelCount: this.intOrNull((p as any).panelCount),
          horizontalHeights: this.jsonArrayOrNull((p as any).horizontalHeights),

          idProd: p.idProd,
          idBrand: p.idBrand,
          idSyst: p.idSyst,
          idConf: p.idConf,
          idFC: p.idFC,
          idCryst: p.idCryst ?? null,
          idTint: p.idTint ?? null,
          idCoat: p.idCoat ?? null,

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
        expiresAt,
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
              conf: {
                include: {
                  category: true,
                },
              },
              fColor: true,
              cryst: true,
              tin: true,
              coat: true,

              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,

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

        const muntinCreate = this.muntinService.buildPieceMuntinCreateInput(sourcePiece.muntin);

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
                    panelCode: panel.panelCode ?? null,
                    panelLabel: panel.panelLabel,
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
              conf: {
                include: {
                  category: true,
                },
              },
              fColor: true,
              cryst: true,
              tin: true,
              coat: true,

              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,

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
        before: EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after: EstimateAuditSnapshotBuilder.build(refreshedEstimate),
        meta: { source: 'EstimatesService.updateEstimate' },
      });

      return refreshedEstimate;
    });

    return result as EstimateWithRelations;
  }

  // recalcular estimado
  async recalculateExpiredEstimate(
    estimateId: number,
    user: AuthUser,
  ): Promise<EstimateWithRelations> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });

    if (!dbUser) throw new NotFoundException('User not found');

    const effectiveMarkupDecimal =
      dbUser.markupOverride !== null
        ? new Decimal(dbUser.markupOverride.toString())
        : new Decimal(dbUser.role.markup.toString());

    const result = await this.prisma.$transaction(async (tx) => {
      const beforeEstimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          user: true,
          status: true,
          order: true,
          pieces: {
            orderBy: { id: 'asc' },
            include: {
              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,
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

      if (!beforeEstimate) {
        throw new NotFoundException(`Estimate #${estimateId} not found.`);
      }

      if (!isPrivileged(user) && beforeEstimate.idUser !== user.id) {
        throw new NotFoundException(`Estimate #${estimateId} not found.`);
      }

      if (beforeEstimate.status?.name !== 'Expired') {
        throw new BadRequestException(
          `Only expired estimates can be recalculated. Current status: ${beforeEstimate.status?.name ?? 'UNKNOWN'
          }.`,
        );
      }

      if (beforeEstimate.order) {
        throw new BadRequestException(
          `Estimate #${estimateId} already has an order and cannot be recalculated.`,
        );
      }

      const activeStatus = await tx.estimateStatus.findUnique({
        where: { name: 'Active' },
        select: { id: true },
      });

      if (!activeStatus) {
        throw new InternalServerErrorException(
          'EstimateStatus "Active" not seeded.',
        );
      }

      const taxParameter = await tx.globalParameter.findUnique({
        where: { key: GlobalParameterKey.SALES_TAX },
      });

      if (!taxParameter) {
        throw new InternalServerErrorException('SALES_TAX config missing.');
      }

      const expiresAt = await this.getEstimateExpirationDate(
        tx as PrismaTransactionClient,
      );

      const factoryTaxRate = dbUser.isTaxExempt
        ? new Decimal(0)
        : new Decimal(taxParameter.value.toString());

      const customerTaxRate = new Decimal(
        Number(beforeEstimate.customerTaxRate ?? 0),
      );

      const pieceDtos: UpsertPieceDto[] = beforeEstimate.pieces.map((p) => ({
        id: p.id,
        mark: p.mark,
        idProd: p.idProd,
        idBrand: p.idBrand,
        idSyst: p.idSyst,
        idConf: p.idConf,
        idFC: p.idFC,

        width: p.width == null ? null : p.width.toString(),
        height: p.height == null ? null : p.height.toString(),
        heightLeft: p.heightLeft == null ? null : p.heightLeft.toString(),
        heightRight: p.heightRight == null ? null : p.heightRight.toString(),
        legHeight: p.legHeight == null ? null : p.legHeight.toString(),
        sashHeight:
          (p as any).sashHeight == null
            ? null
            : (p as any).sashHeight.toString(),
        windowHeight:
          (p as any).windowHeight == null
            ? null
            : (p as any).windowHeight.toString(),
        doorWidth:
          (p as any).doorWidth == null
            ? null
            : (p as any).doorWidth.toString(),
        doorHeight:
          (p as any).doorHeight == null
            ? null
            : (p as any).doorHeight.toString(),
        leftSideliteWidth:
          (p as any).leftSideliteWidth == null
            ? null
            : (p as any).leftSideliteWidth.toString(),
        rightSideliteWidth:
          (p as any).rightSideliteWidth == null
            ? null
            : (p as any).rightSideliteWidth.toString(),
        leftPanels: (p as any).leftPanels ?? null,
        rightPanels: (p as any).rightPanels ?? null,
        panelCount: (p as any).panelCount ?? null,
        horizontalHeights: Array.isArray((p as any).horizontalHeights)
          ? ((p as any).horizontalHeights as number[])
          : null,

        idCryst: p.idCryst ?? null,
        idTint: p.idTint ?? null,
        privacy: p.privacy ?? false,
        idCoat: p.idCoat ?? null,
        screen: p.screen ?? false,
        highBottom: (p as any).highBottom ?? false,

        idActiveOption: p.idActiveOption ?? null,
        idPreparationOption: p.idPreparationOption ?? null,
        idSillOption: p.idSillOption ?? null,
        idReinforcementOption: p.idReinforcementOption ?? null,

        muntin: p.pieceMuntin
          ? {
            idPattern: p.pieceMuntin.patternId,
            idType: p.pieceMuntin.typeId ?? null,
            panels: p.pieceMuntin.panels.map((panel) => ({
              panelIndex: panel.panelIndex,
              panelCode: panel.panelCode ?? undefined,
              panelLabel: panel.panelLabel,
              horizontalLites: panel.horizontalLites,
              verticalLites: panel.verticalLites,
            })),
          }
          : null,

        qty: p.qty,

        //  en DB está guardado como decimal 0.15, pero el cálculo espera 15
        dealerMarkup: Number(p.dealerMarkup ?? 0) * 100,
      }));
      const cache = this.pieceCalculator.createCalculationCache();
      const calculatedPieces: CalculatedPieceCombined[] = [];

      for (const p of pieceDtos) {
        const result = await this.pieceCalculator.calculatePieceMetrics(
          p,
          effectiveMarkupDecimal,
          tx as PrismaTransactionClient,
          cache
        );

        calculatedPieces.push(result);
      }

      const estimateTotals = this.pieceCalculator.calculateEstimateTotals(
        calculatedPieces,
        factoryTaxRate,
        customerTaxRate,
      );

      const totalUnits = calculatedPieces.reduce(
        (sum, p) => sum + (p.qty || 0),
        0,
      );

      for (const p of calculatedPieces) {
        const pieceId = (p as UpsertPieceDto).id;

        if (!pieceId) continue;

        await tx.piece.update({
          where: { id: pieceId },
          data: {
            mark: p.mark,
            privacy: p.privacy ?? false,
            screen: p.screen ?? false,
            highBottom: p.highBottom ?? false,
            highBottomPercent: p.highBottomPercent
              ? new Prisma.Decimal(p.highBottomPercent.toFixed(4))
              : null,
            qty: p.qty,

            idActiveOption: p.idActiveOption ?? null,
            idPreparationOption: p.idPreparationOption ?? null,
            idSillOption: p.idSillOption ?? null,
            idReinforcementOption: p.idReinforcementOption ?? null,

            rate: new Prisma.Decimal(p.rate.toFixed(2)),
            price: new Prisma.Decimal(p.price.toFixed(2)),
            markup: new Prisma.Decimal(p.markup.toFixed(4)),
            subtotal: new Prisma.Decimal(p.subtotal.toFixed(2)),
            dealerMarkup: new Prisma.Decimal(
              p.dealerMarkupDecimal.toFixed(4),
            ),
            netProfit: new Prisma.Decimal(p.netProfit.toFixed(2)),
            netProfitD: new Prisma.Decimal(p.netProfitD.toFixed(2)),
            customerPrice: new Prisma.Decimal(p.customerPrice.toFixed(2)),
            customerSubtotal: new Prisma.Decimal(
              p.customerSubtotal.toFixed(2),
            ),

            width: this.decimalOrNull(p.width),
            height: this.decimalOrNull(p.height),
            heightLeft: this.decimalOrNull(p.heightLeft),
            heightRight: this.decimalOrNull(p.heightRight),
            legHeight: this.decimalOrNull(p.legHeight),
            sashHeight: this.decimalOrNull((p as any).sashHeight),
            windowHeight: this.decimalOrNull((p as any).windowHeight),

            doorWidth: this.decimalOrNull((p as any).doorWidth),
            doorHeight: this.decimalOrNull((p as any).doorHeight),
            leftSideliteWidth: this.decimalOrNull((p as any).leftSideliteWidth),
            rightSideliteWidth: this.decimalOrNull((p as any).rightSideliteWidth),
            leftPanels: this.intOrNull((p as any).leftPanels),
            rightPanels: this.intOrNull((p as any).rightPanels),
            panelCount: this.intOrNull((p as any).panelCount),
            horizontalHeights: this.jsonArrayOrNull((p as any).horizontalHeights),

            idProd: p.idProd,
            idBrand: p.idBrand,
            idSyst: p.idSyst,
            idConf: p.idConf,
            idFC: p.idFC,
            idCryst: p.idCryst ?? null,
            idTint: p.idTint ?? null,
            idCoat: p.idCoat ?? null,

            dpPosPsf: new Prisma.Decimal(p.dpPosPsf.toFixed(2)),
            dpNegPsf: new Prisma.Decimal(p.dpNegPsf.toFixed(2)),
          },
        });

        await tx.pieceMuntin.deleteMany({
          where: { pieceId },
        });

        if (p.muntin) {
          const muntinCreate = this.muntinService.buildPieceMuntinCreateInput(p.muntin);

          if (muntinCreate) {
            await tx.pieceMuntin.create({
              data: {
                piece: { connect: { id: pieceId } },
                pattern: { connect: { id: p.muntin.idPattern } },
                ...(p.muntin.idType
                  ? { type: { connect: { id: p.muntin.idType } } }
                  : {}),
                totalLites: muntinCreate.totalLites,
                ...(p.muntin.panels.length > 0
                  ? {
                    panels: {
                      create: p.muntin.panels.map((panel) => ({
                        panelIndex: panel.panelIndex,
                        panelCode: panel.panelCode ?? null,
                        panelLabel: panel.panelLabel,
                        horizontalLites: panel.horizontalLites,
                        verticalLites: panel.verticalLites,
                      })),
                    },
                  }
                  : {}),
              },
            });
          }
        }
      }

      await tx.estimate.update({
        where: { id: estimateId },
        data: {
          ...estimateTotals,
          units: totalUnits,
          expiresAt,
          status: {
            connect: { id: activeStatus.id },
          },
        },
      });

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
              conf: {
                include: {
                  category: true,
                },
              },
              fColor: true,
              cryst: true,
              tin: true,
              coat: true,
              activeOption: true,
              preparationOption: true,
              sillOption: true,
              reinforcementOption: true,
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
        throw new NotFoundException(
          `Estimate #${estimateId} not found after recalculation.`,
        );
      }

      await this.logs.log({
        action: 'RECALCULATE',
        entityType: 'Estimate',
        entityId: refreshedEstimate.id,
        userId: user.id,
        message: `Estimate recalculated (#${refreshedEstimate.number})`,
        before: EstimateAuditSnapshotBuilder.build(beforeEstimate),
        after: EstimateAuditSnapshotBuilder.build(refreshedEstimate),
        meta: { source: 'EstimatesService.recalculateExpiredEstimate' },
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

      if (estimate.order) {
        throw new BadRequestException(
          `Estimate #${where.id} already has an order and cannot be deleted.`,
        );
      }

      const beforeSnapshot = EstimateAuditSnapshotBuilder.build(estimate);

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

  async previewDimensionValidation(input: {
    idSyst: number;
    idConf: number;
    idCryst: number;
    idReinforcementOption?: number | null;
    width?: number;
    height: number;
    heightLeft?: number;
    heightRight?: number;
    legHeight?: number;

    doorWidth?: number;
    doorHeight?: number;
    leftSideliteWidth?: number;
    rightSideliteWidth?: number;
    leftPanels?: number;
    rightPanels?: number;
    panelCount?: number;
    horizontalHeights?: number[];
  }) {
    return this.prisma.$transaction(async (tx) => {
      const dto: any = {
        idSyst: input.idSyst,
        idConf: input.idConf,
        idCryst: input.idCryst,
        idReinforcementOption: input.idReinforcementOption ?? null,
        width: input.width != null ? String(input.width) : undefined,
        height: input.height != null ? String(input.height) : undefined,
        heightLeft:
          input.heightLeft != null ? String(input.heightLeft) : undefined,
        heightRight:
          input.heightRight != null ? String(input.heightRight) : undefined,
        legHeight:
          input.legHeight != null ? String(input.legHeight) : undefined,

        doorWidth:
          input.doorWidth != null ? String(input.doorWidth) : undefined,
        doorHeight:
          input.doorHeight != null ? String(input.doorHeight) : undefined,
        leftSideliteWidth:
          input.leftSideliteWidth != null
            ? String(input.leftSideliteWidth)
            : undefined,
        rightSideliteWidth:
          input.rightSideliteWidth != null
            ? String(input.rightSideliteWidth)
            : undefined,
        leftPanels: input.leftPanels ?? undefined,
        rightPanels: input.rightPanels ?? undefined,
        panelCount: input.panelCount ?? undefined,
        horizontalHeights: Array.isArray(input.horizontalHeights)
          ? input.horizontalHeights
          : undefined,
      };

      const res =
        await this.dimensionValidationService.validateAgainstDimensionPolicy(
          dto,
          tx as any,
        );
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
  // PDF on-the-fly (Buffer) con 4 vistas
  // =====================================================
  async generateEstimatePdfBufferForUser(
    estimateId: number,
    user: AuthUser,
    view: PdfView,
  ): Promise<Buffer> {
    const estimate = await this.findOneForUser(estimateId, user);

    return this.estimatePdfService.generateEstimatePdfBuffer({
      estimate,
      user,
      view,
    });
  }

}

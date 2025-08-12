import { Injectable, NotFoundException } from '@nestjs/common';
import { Estimate, Prisma, Piece, PrismaClient } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';
import { PricingRulesService } from 'src/pricing-rules/pricing-rules.service';

// --- INICIO DE LA CORRECCIÓN DEFINITIVA ---
// 1. Definimos un tipo explícito para el resultado de nuestros cálculos.
//    Hereda de UpsertPieceDto (que tiene 'id' y 'idEst' opcionales) y añade los campos calculados.
type PieceWithMetrics = UpsertPieceDto & {
  rate: Prisma.Decimal;
  price: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  markup: number;
  subtotal: Prisma.Decimal;
  markupD: Prisma.Decimal;
  netProfitD: Prisma.Decimal;
};
// --- FIN DE LA CORRECCIÓN DEFINITIVA ---

@Injectable()
export class EstimatesService {
  constructor(
    private prisma: PrismaService,
    private pricingRulesService: PricingRulesService,
  ) {}

  // --- NUEVO MÉTODO PÚBLICO PARA CÁLCULO ---
  async calculateAndReturnPieceMetrics(
    pieceDto: CreatePieceDto,
    userId: number,
  ): Promise<PieceWithMetrics> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    // Llamamos a la función de cálculo privada, pasándole el cliente de Prisma principal
    // en lugar de un cliente de transacción, ya que no estamos guardando nada.
    return this.calculatePieceMetrics(pieceDto, new Prisma.Decimal(effectiveMarkup), this.prisma);
  }

  async estimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate | null> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: {
        user: true,
        pieces: {
          orderBy: { id: 'asc' },
          include: {
            prod: true, bran: true, syst: true, conf: true,
            fColor: true, cryst: true, tin: true, coat: true,
          },
        },
      },
    });
    if (!estimate) { return null; }
    return estimate;
  }

  async estimates(params: { where?: Prisma.EstimateWhereInput; }): Promise<Estimate[]> {
    return this.prisma.estimate.findMany({
      where: params.where,
      include: { user: true },
    });
  }

  async createEstimate(
    dto: CreateEstimateDto,
    userId: number,
  ): Promise<Estimate> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    return this.prisma.$transaction(async (tx) => {
      const lastEstimate = await tx.estimate.findFirst({
        orderBy: { number: 'desc' },
      });
      const nextNumber = !lastEstimate ? '190909' : String(parseInt(lastEstimate.number, 10) + 1);

      const { pieces, ...estimateHeaderData } = dto;

      const piecesDataPromises = pieces.map((p) =>
        this.calculatePieceMetrics(p, new Prisma.Decimal(effectiveMarkup), tx)
      );
      const piecesData = await Promise.all(piecesDataPromises);

      const estimateTotals = this.calculateEstimateTotals(piecesData);
      const totalUnits = pieces.reduce((sum, p) => sum + p.qty, 0);

      const newEstimate = await tx.estimate.create({
        data: {
          number: nextNumber,
          ...estimateHeaderData,
          ...estimateTotals,
          units: totalUnits,
          active: true,
          user: { connect: { id: userId } },
          pieces: {
            create: piecesData.map(
              ({ id, idEst, idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...rest }) => ({
                ...rest,
                prod: { connect: { id: idProd } },
                bran: { connect: { id: idBrand } },
                syst: { connect: { id: idSyst } },
                conf: { connect: { id: idConf } },
                fColor: { connect: { id: idFC } },
                cryst: { connect: { id: idCryst } },
                tin: { connect: { id: idTint } },
                coat: { connect: { id: idCoat } },
              }),
            ),
          },
        },
        include: { pieces: true, user: true },
      });
      
      return newEstimate;
    });
  }

  async updateEstimate(
    estimateId: number,
    dto: UpdateEstimateDto,
    userId: number,
  ): Promise<Estimate> {
    const { pieces = [], ...estimateHeaderData } = dto;
    
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    return this.prisma.$transaction(async (tx) => {
      const existingEstimate = await tx.estimate.findUnique({ where: { id: estimateId } });
      if (!existingEstimate || existingEstimate.idUser !== userId) {
        throw new NotFoundException(`Estimate with ID #${estimateId} not found or access denied.`);
      }

      const incomingPieceIds = pieces.map((p) => p.id).filter(Boolean);
      await tx.piece.deleteMany({
        where: { idEst: estimateId, NOT: { id: { in: incomingPieceIds } } },
      });

      const piecesDataPromises = pieces.map((p) =>
        this.calculatePieceMetrics(p, new Prisma.Decimal(effectiveMarkup), tx)
      );
      const piecesDataWithMetrics = await Promise.all(piecesDataPromises);

      // Ahora TypeScript sabe que 'p' es de tipo 'PieceWithMetrics' y tiene 'id' y 'idEst'.
      const piecesToUpsert = piecesDataWithMetrics.map((p) => {
        const { id, idEst, idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...rest } = p;
        const relations = {
          prod: { connect: { id: idProd } }, bran: { connect: { id: idBrand } },
          syst: { connect: { id: idSyst } }, conf: { connect: { id: idConf } },
          fColor: { connect: { id: idFC } }, cryst: { connect: { id: idCryst } },
          tin: { connect: { id: idTint } }, coat: { connect: { id: idCoat } },
        };
        return {
          where: { id: id || -1 },
          update: { ...rest, ...relations },
          create: { ...rest, ...relations },
        };
      });

      const estimateTotals = this.calculateEstimateTotals(piecesDataWithMetrics);
      const totalUnits = pieces.reduce((sum, p) => sum + p.qty, 0);

      return tx.estimate.update({
        where: { id: estimateId },
        data: {
          ...estimateHeaderData,
          ...estimateTotals,
          units: totalUnits,
          pieces: { upsert: piecesToUpsert },
        },
        include: { pieces: true, user: true },
      });
    });
  }

  async deleteEstimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({ where });
      if (!estimate) {
        throw new NotFoundException(`Estimate with ID #${where.id} not found.`);
      }
      await tx.piece.deleteMany({ where: { idEst: where.id } });
      await tx.estimate.delete({ where: { id: where.id } });
      return estimate;
    });
  }

  private async calculatePieceMetrics(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    markupPercentage: Prisma.Decimal,
    tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  ): Promise<PieceWithMetrics> { // <-- 2. APLICAMOS EL TIPO DE RETORNO EXPLÍCITO
    const width = parseFloat(pieceDto.width);
    const height = parseFloat(pieceDto.height);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      throw new Error(`Invalid dimensions for piece mark: ${pieceDto.mark}`);
    }

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
      throw new NotFoundException(`No pricing rule found for the combination in piece mark: ${pieceDto.mark}. Please define one.`);
    }

    const area = new Prisma.Decimal(width * height);
    const perimeter = new Prisma.Decimal(2 * (width + height));
    
    const areaCost = area.mul(rule.costoA);
    const perimeterCost = perimeter.mul(rule.costoB);
    const fixedCost = new Prisma.Decimal(rule.costoC);

    // Aplicando tu fórmula para 'rate' (costo), sin extras.
    const rate = areaCost.add(perimeterCost).add(fixedCost);
    
    // Aplicando tus definiciones para el resto de los campos
    const markupAmount = rate.mul(markupPercentage);
    const price = rate.add(markupAmount);
    const netProfit = price.sub(rate);

    return {
      ...pieceDto,
      rate,
      price,
      netProfit,
      markup: parseInt(markupPercentage.mul(100).toString()),
      // Dejando los otros valores en 0 como pediste
      subtotal: new Prisma.Decimal(0),
      markupD: new Prisma.Decimal(0),
      netProfitD: new Prisma.Decimal(0),
    };
  }

  private calculateEstimateTotals(pieces: PieceWithMetrics[]) {
    const totals = pieces.reduce(
      (acc, piece) => {
        const qty = new Prisma.Decimal(piece.qty);
        // rateT es la suma de los costos totales (costo unitario * cantidad)
        acc.rateT = acc.rateT.add(new Prisma.Decimal(piece.rate).mul(qty));
        // priceT es la suma de los precios totales (precio unitario * cantidad)
        acc.priceT = acc.priceT.add(new Prisma.Decimal(piece.price).mul(qty));
        return acc;
      },
      {
        rateT: new Prisma.Decimal(0),
        priceT: new Prisma.Decimal(0),
      },
    );

    // netProfit es la diferencia entre el precio total de venta y el costo total
    const netProfit = totals.priceT.sub(totals.rateT);

    return {
      rateT: totals.rateT,
      priceT: totals.priceT,
      netProfit: netProfit,
      // Dejando los otros valores en 0 como pediste
      total: new Prisma.Decimal(0),
      netProfitD: new Prisma.Decimal(0),
    };
  }
}

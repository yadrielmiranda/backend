// src/estimates/estimates.service.ts
import { Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { Estimate, Prisma, PrismaClient, GlobalParameterKey } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';

// --- CORRECCIÓN 1: Ajustar el tipo interno ---
// Heredamos de UpsertPieceDto para incluir 'id' y 'idEst' opcionales, crucial para las actualizaciones.
type PieceWithCalculations = Omit<UpsertPieceDto, 'dealerMarkup'> & {
  rate: Prisma.Decimal;
  price: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  markup: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  netProfitD: Prisma.Decimal;
  dealerMarkup: Prisma.Decimal;
};

@Injectable()
export class EstimatesService {
  constructor(private prisma: PrismaService) {}

  async calculateAndReturnPieceMetrics(
    pieceDto: CreatePieceDto,
    userId: number,
  ): Promise<PieceWithCalculations> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    // Usamos el cliente de Prisma principal porque esto es solo un cálculo, no una transacción de guardado.
    return this.calculatePieceMetrics(pieceDto, new Prisma.Decimal(effectiveMarkup), this.prisma);
  }

  async estimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate | null> {
    return this.prisma.estimate.findUnique({
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
  }

  async estimates(params: { where?: Prisma.EstimateWhereInput; }): Promise<Estimate[]> {
    return this.prisma.estimate.findMany({
      where: params.where,
      include: { user: true },
    });
  }

  async createEstimate(dto: CreateEstimateDto, userId: number): Promise<Estimate> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    return this.prisma.$transaction(async (tx) => {
      const taxParameter = await tx.globalParameter.findUnique({ where: { key: GlobalParameterKey.SALES_TAX } });
      if (!taxParameter) throw new InternalServerErrorException('SALES_TAX parameter not configured.');
      const taxRate = taxParameter.value;

      const lastEstimate = await tx.estimate.findFirst({ orderBy: { number: 'desc' } });
      const nextNumber = !lastEstimate ? '190909' : String(parseInt(lastEstimate.number, 10) + 1);
      
      const { pieces, ...estimateHeaderData } = dto;
      
      const piecesDataPromises = pieces.map((p) => this.calculatePieceMetrics(p, new Prisma.Decimal(effectiveMarkup), tx));
      const piecesWithCalculations = await Promise.all(piecesDataPromises);
      
      const estimateTotals = this.calculateEstimateTotals(piecesWithCalculations, taxRate);
      const totalUnits = pieces.reduce((sum, p) => sum + p.qty, 0);

      const piecesToCreate = piecesWithCalculations.map(p => {
        const { id, idEst, idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...pieceData } = p;
        return {
            ...pieceData,
            prod: { connect: { id: idProd } },
            bran: { connect: { id: idBrand } },
            syst: { connect: { id: idSyst } },
            conf: { connect: { id: idConf } },
            fColor: { connect: { id: idFC } },
            cryst: { connect: { id: idCryst } },
            tin: { connect: { id: idTint } },
            coat: { connect: { id: idCoat } },
        };
      });

      return tx.estimate.create({
        data: {
          number: nextNumber,
          ...estimateHeaderData,
          ...estimateTotals,
          units: totalUnits,
          active: true,
          user: { connect: { id: userId } },
          pieces: {
            create: piecesToCreate,
          },
        },
        include: { pieces: true, user: true },
      });
    });
  }
  
  async updateEstimate(estimateId: number, dto: UpdateEstimateDto, userId: number): Promise<Estimate> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    const effectiveMarkup = user.markupOverride ?? user.role.markup;

    return this.prisma.$transaction(async (tx) => {
        const taxParameter = await tx.globalParameter.findUnique({ where: { key: GlobalParameterKey.SALES_TAX } });
        if (!taxParameter) throw new InternalServerErrorException('SALES_TAX parameter not configured.');
        const taxRate = taxParameter.value;

        const { pieces = [], ...estimateHeaderData } = dto;
        
        const existingEstimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!existingEstimate || existingEstimate.idUser !== userId) {
            throw new NotFoundException(`Estimate with ID #${estimateId} not found or access denied.`);
        }

        const incomingPieceIds = pieces.map((p) => p.id).filter(Boolean);
        await tx.piece.deleteMany({ where: { idEst: estimateId, NOT: { id: { in: incomingPieceIds } } } });

        const piecesDataPromises = pieces.map((p) => this.calculatePieceMetrics(p, new Prisma.Decimal(effectiveMarkup), tx));
        const piecesWithCalculations = await Promise.all(piecesDataPromises);
        
        const piecesToUpsert = piecesWithCalculations.map((p) => {
            const { id, idEst, idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...rest } = p;
            const pieceDataForDb = {
                ...rest,
                prod:   { connect: { id: idProd } },
                bran:   { connect: { id: idBrand } },
                syst:   { connect: { id: idSyst } },
                conf:   { connect: { id: idConf } },
                fColor: { connect: { id: idFC } },
                cryst:  { connect: { id: idCryst } },
                tin:    { connect: { id: idTint } },
                coat:   { connect: { id: idCoat } },
            };
            return { 
                where: { id: p.id || -1 }, 
                update: pieceDataForDb, 
                create: pieceDataForDb, 
            };
        });

        const estimateTotals = this.calculateEstimateTotals(piecesWithCalculations, taxRate);
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
      if (!estimate) throw new NotFoundException(`Estimate with ID #${where.id} not found.`);
      await tx.piece.deleteMany({ where: { idEst: where.id } });
      await tx.estimate.delete({ where: { id: where.id } });
      return estimate;
    });
  }

private async calculatePieceMetrics(
    pieceDto: CreatePieceDto | UpsertPieceDto,
    // Este markup ya viene como un decimal (ej: 0.15) desde la base de datos
    effectiveMarkup: Prisma.Decimal, 
    tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  ): Promise<PieceWithCalculations> {
    const width = parseFloat(pieceDto.width);
    const height = parseFloat(pieceDto.height);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      throw new Error(`Invalid dimensions for piece mark: ${pieceDto.mark}`);
    }

    const rule = await tx.pricingRule.findUnique({
      where: {
        idBrand_idProduct_idSystem_idConfig_idCrystal: {
          idBrand: pieceDto.idBrand, idProduct: pieceDto.idProd, idSystem: pieceDto.idSyst,
          idConfig: pieceDto.idConf, idCrystal: pieceDto.idCryst,
        },
      },
    });
    if (!rule) {
      throw new NotFoundException(`No pricing rule found for the combination in piece mark: ${pieceDto.mark}.`);
    }

    const area = new Prisma.Decimal((width * height) / 144); // divido por 144 porque las medidas estan en pulgadas y necesito el area en pies cuadrados 
    const perimeter = new Prisma.Decimal((2 * (width + height)) / 12); // divido por 12 porque las medidas estan en pulgadas y necesito el perimetro en pies
    const areaCost = area.mul(rule.costoA);
    const perimeterCost = perimeter.mul(rule.costoB);
    const fixedCost = new Prisma.Decimal(rule.costoC);
    const rate = areaCost.add(perimeterCost).add(fixedCost);
    
    // 1. TU MARKUP: Se usa el 'effectiveMarkup' (ej: 0.15) directamente.
    const markupAmount = rate.mul(effectiveMarkup);
    const price = rate.add(markupAmount);
    const netProfit = price.sub(rate);

    // 2. DEALER MARKUP: Se convierte el input del frontend (ej: 15.5) a decimal (0.155).
    const dealerMarkupFromDto = new Prisma.Decimal(pieceDto.dealerMarkup || 0);
    const dealerMarkupAsDecimal = dealerMarkupFromDto.div(100);
    
    const dealerMarkupAmount = price.mul(dealerMarkupAsDecimal);
    const subtotal = price.add(dealerMarkupAmount); 
    const netProfitD = subtotal.sub(price);
    
    // Descartamos el dealerMarkup que viene del DTO para evitar conflictos de tipo.
    const { dealerMarkup, ...restOfPieceDto } = pieceDto;

    return {
      ...restOfPieceDto,
      rate,
      price,
      netProfit,
      markup: effectiveMarkup, // Se guarda tu markup como decimal (ej: 0.1500)
      dealerMarkup: dealerMarkupAsDecimal, // Se guarda el markup del dealer como decimal (ej: 0.1550)
      netProfitD,
      subtotal,
    };
  }

  private calculateEstimateTotals(pieces: PieceWithCalculations[], taxRate: Prisma.Decimal) {
    // --- CORRECCIÓN 3: La cantidad (qty) se aplica aquí, al sumar los totales ---
    const baseTotals = pieces.reduce(
      (acc, piece) => {
        const qty = new Prisma.Decimal(piece.qty);
        // Multiplicamos los valores unitarios por la cantidad de cada pieza
        acc.rateT = acc.rateT.add(piece.rate.mul(qty));
        acc.priceT = acc.priceT.add(piece.price.mul(qty));
        acc.total = acc.total.add(piece.subtotal.mul(qty)); // El total final del dealer
        acc.netProfitD = acc.netProfitD.add(piece.netProfitD.mul(qty)); // La ganancia total del dealer
        return acc;
      },
      {
        rateT: new Prisma.Decimal(0),      // Tu costo total
        priceT: new Prisma.Decimal(0),     // Tu precio total de venta
        total: new Prisma.Decimal(0),      // El precio final total para el cliente del dealer
        netProfitD: new Prisma.Decimal(0), // La ganancia total del dealer
      },
    );

    // Tu ganancia total
    const yourNetProfit = baseTotals.priceT.sub(baseTotals.rateT);
    
    // El impuesto se calcula sobre TU precio de venta (priceT)
    const taxAmount = baseTotals.priceT.mul(taxRate);
    
    // El total que te deben pagar a TI (cliente o dealer)
    const totalPayable = baseTotals.priceT.add(taxAmount);

    return {
      rateT: baseTotals.rateT,
      priceT: baseTotals.priceT,
      netProfit: yourNetProfit,
      taxRate: taxRate,
      taxAmount: taxAmount,
      totalPayable: totalPayable,
      total: baseTotals.total,
      netProfitD: baseTotals.netProfitD,
    };
  }
}
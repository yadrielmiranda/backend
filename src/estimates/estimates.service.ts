import { Injectable, NotFoundException } from '@nestjs/common';
import { Estimate, Prisma, Piece } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto, UpsertPieceDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto';

@Injectable()
export class EstimatesService {
  constructor(private prisma: PrismaService) {}

  async estimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate | null> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: {
        user: true,
        pieces: {
          orderBy: {
            id: 'asc',
          },
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

    if (!estimate) {
      return null;
    }
    return estimate;
  }

  async estimates(params: {
    where?: Prisma.EstimateWhereInput;
  }): Promise<Estimate[]> {
    return this.prisma.estimate.findMany({
      where: params.where,
      include: { user: true },
    });
  }

  async createEstimate(
    dto: CreateEstimateDto,
    userId: number,
  ): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      const lastEstimate = await tx.estimate.findFirst({
        orderBy: { number: 'desc' },
      });

      let nextNumber: string;
      if (!lastEstimate) {
        nextNumber = '190909';
      } else {
        const lastNumber = parseInt(lastEstimate.number, 10);
        nextNumber = String(lastNumber + 1);
      }

      const { pieces, ...estimateHeaderData } = dto;

      const piecesData = pieces.map((p) => {
        const metrics = this.calculatePieceMetrics(p);
        return { ...p, ...metrics };
      });

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
              ({ idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...rest }) => ({
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

    return this.prisma.$transaction(async (tx) => {
      const existingEstimate = await tx.estimate.findUnique({
        where: { id: estimateId },
      });
      if (!existingEstimate || existingEstimate.idUser !== userId) {
        throw new NotFoundException(`Estimate with ID #${estimateId} not found or access denied.`);
      }

      const incomingPieceIds = pieces.map((p) => p.id).filter(Boolean);
      await tx.piece.deleteMany({
        where: {
          idEst: estimateId,
          NOT: { id: { in: incomingPieceIds } },
        },
      });

      const piecesToUpsert = pieces.map((p: UpsertPieceDto) => {
        const metrics = this.calculatePieceMetrics(p);
        const pieceDataWithMetrics = { ...p, ...metrics };

        const { id, idEst, idProd, idBrand, idSyst, idConf, idFC, idCryst, idTint, idCoat, ...rest } = pieceDataWithMetrics;

        const relations = {
          prod: { connect: { id: idProd } },
          bran: { connect: { id: idBrand } },
          syst: { connect: { id: idSyst } },
          conf: { connect: { id: idConf } },
          fColor: { connect: { id: idFC } },
          cryst: { connect: { id: idCryst } },
          tin: { connect: { id: idTint } },
          coat: { connect: { id: idCoat } },
        };

        const createData = { ...rest, ...relations };
        const updateData = { ...rest, ...relations };

        return {
          where: { id: id || -1 },
          update: updateData,
          create: createData,
        };
      });

      const updatedPiecesWithMetrics = pieces.map(p => ({...p, ...this.calculatePieceMetrics(p)}));
      const estimateTotals = this.calculateEstimateTotals(updatedPiecesWithMetrics);
      const totalUnits = pieces.reduce((sum, p) => sum + p.qty, 0);

      const updatedEstimate = await tx.estimate.update({
        where: { id: estimateId },
        data: {
          ...estimateHeaderData,
          ...estimateTotals,
          units: totalUnits,
          pieces: {
            upsert: piecesToUpsert,
          },
        },
        include: { pieces: true, user: true },
      });

      return updatedEstimate;
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

  private calculatePieceMetrics(pieceDto: CreatePieceDto | UpsertPieceDto): {
    price: Prisma.Decimal;
    subtotal: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    rate: Prisma.Decimal;
    markup: number;
    markupD: Prisma.Decimal;
    netProfitD: Prisma.Decimal;
  } {
    let priceNumber = 100.0;
    if (pieceDto.screen) priceNumber += 20;
    if (pieceDto.muntin) priceNumber += 15;

    const subtotalNumber = priceNumber * pieceDto.qty;
    const netProfitNumber = subtotalNumber * 0.2;
    const markupDNumber = subtotalNumber * 0.3;
    const netProfitDNumber = subtotalNumber * 0.25;

    return {
      price: new Prisma.Decimal(priceNumber),
      subtotal: new Prisma.Decimal(subtotalNumber),
      netProfit: new Prisma.Decimal(netProfitNumber),
      rate: new Prisma.Decimal(0),
      markup: 0,
      markupD: new Prisma.Decimal(markupDNumber),
      netProfitD: new Prisma.Decimal(netProfitDNumber),
    };
  }

  private calculateEstimateTotals(pieces: any[]): {
    priceT: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    rateT: Prisma.Decimal;
    total: Prisma.Decimal;
    netProfitD: Prisma.Decimal;
  } {
    const totals = pieces.reduce(
      (acc, piece) => {
        const subtotal = new Prisma.Decimal(piece.subtotal);
        const netProfit = new Prisma.Decimal(piece.netProfit);
        const netProfitD = new Prisma.Decimal(piece.netProfitD);

        acc.priceT = acc.priceT.add(subtotal);
        acc.netProfit = acc.netProfit.add(netProfit);
        acc.netProfitD = acc.netProfitD.add(netProfitD);
        return acc;
      },
      {
        priceT: new Prisma.Decimal(0),
        netProfit: new Prisma.Decimal(0),
        netProfitD: new Prisma.Decimal(0),
      },
    );

    return {
      priceT: totals.priceT,
      netProfit: totals.netProfit,
      rateT: new Prisma.Decimal(0),
      total: totals.priceT,
      netProfitD: totals.netProfitD,
    };
  }
}

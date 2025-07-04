import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Estimate, Prisma } from '@prisma/client';
import { CreateEstimateDto } from './dto/create-estimate.dto';
import { UpdateEstimateDto } from './dto/update-estimate.dto';
import { CreatePieceDto } from 'src/pieces/dto/create-piece.dto'; // Asegúrate que la ruta sea correcta

@Injectable()
export class EstimatesService {

  constructor(private prisma: PrismaService) { }

  /**
   * Obtiene un único presupuesto por su ID, incluyendo todas sus piezas.
   * Lanza un error 404 si no se encuentra.
   */
  async estimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    const estimate = await this.prisma.estimate.findUnique({
      where,
      include: {
        pieces: true,
      },
    });

    if (!estimate) {
      throw new NotFoundException(`Estimate with ID #${where.id} not found.`);
    }
    return estimate;
  }

  /**
   * Obtiene una lista de presupuestos (sin piezas, para un listado rápido).
   */
  async estimates(params: {
    where?: Prisma.EstimateWhereInput;
    // ... otros parámetros de paginación si los necesitas
  }): Promise<Estimate[]> {
    return this.prisma.estimate.findMany({
      where: params.where,
      // ...
    });
  }

  /**
   * Crea un nuevo presupuesto y todas sus piezas en una única transacción.
   * Calcula los totales en el backend para garantizar la integridad de los datos.
   */
  async createEstimate(dto: CreateEstimateDto): Promise<Estimate> {
    const { pieces, ...estimateHeaderData } = dto;

    // --- 1. LÓGICA DE CÁLCULO DE PRECIOS POR PIEZA ---
    // Aquí es donde tu lógica de negocio determina el precio de cada pieza.
    const calculatedPieces = pieces.map(pieceDto => {
      // Ejemplo conceptual. Reemplaza esto con tus cálculos reales.
      const price = this.calculatePiecePrice(pieceDto); 
      const subtotal = price * pieceDto.qty;
      const netProfit = subtotal * 0.20; // Ejemplo: 20% de ganancia

      return {
        ...pieceDto, // Contiene mark, idProd, qty, etc.
        price,
        subtotal,
        netProfit,
        rate: 0, // Debes calcular esto también
        markup: 0, // Debes calcular esto también
      };
    });

    // --- 2. LÓGICA DE CÁLCULO DE TOTALES DEL PRESUPUESTO ---
    const estimateTotals = calculatedPieces.reduce((totals, piece) => {
      totals.priceT += piece.subtotal;
      totals.netProfit += piece.netProfit;
      return totals;
    }, { priceT: 0, netProfit: 0 });

    // --- 3. CREACIÓN EN BASE DE DATOS ---
    return this.prisma.estimate.create({
      data: {
        ...estimateHeaderData,
        units: calculatedPieces.length,
        priceT: estimateTotals.priceT,
        netProfit: estimateTotals.netProfit,
        rateT: 0, // Debes calcular esto también
        active: true,
        pieces: {
          create: calculatedPieces, // Crea todas las piezas y las asocia
        },
      },
      include: {
        pieces: true, // Devuelve el presupuesto con sus piezas recién creadas
      },
    });
  }

  /**
   * Actualiza los datos de la cabecera de un presupuesto (ej: nombre, proyecto).
   * NO actualiza las piezas ni los totales. Para eso, usar los métodos específicos.
   */
  async updateEstimate(params: {
    where: Prisma.EstimateWhereUniqueInput;
    data: UpdateEstimateDto;
  }): Promise<Estimate> {
    try {
      return await this.prisma.estimate.update({
        where: params.where,
        data: params.data,
      });
    } catch (error) {
      throw new NotFoundException(`Estimate with ID #${params.where.id} not found.`);
    }
  }

  /**
   * Borra un presupuesto y todas sus piezas asociadas en una transacción.
   */
  async deleteEstimate(where: Prisma.EstimateWhereUniqueInput): Promise<Estimate> {
    return this.prisma.$transaction(async (tx) => {
      // Primero, nos aseguramos de que el presupuesto exista para poder devolverlo.
      const estimate = await tx.estimate.findUnique({ where });
      if (!estimate) {
        throw new NotFoundException(`Estimate with ID #${where.id} not found.`);
      }

      // Borramos las piezas asociadas
      await tx.piece.deleteMany({
        where: { idEst: where.id },
      });

      // Borramos el presupuesto
      await tx.estimate.delete({
        where: { id: where.id },
      });

      return estimate;
    });
  }

  // --- MÉTODOS AUXILIARES Y DE LÓGICA DE NEGOCIO ---
  
  /**
   * Función de ejemplo para la lógica de precios.
   * En una aplicación real, esta función sería mucho más compleja.
   */
  private calculatePiecePrice(pieceDto: CreatePieceDto): number {
    // AQUÍ IRÍA TU LÓGICA COMPLEJA:
    // 1. Podrías buscar precios base en la BD según pieceDto.idProd, idCryst, etc.
    // 2. Aplicar fórmulas basadas en width, height.
    // 3. Sumar costos de extras como 'screen' o 'muntin'.
    let calculatedPrice = 100.0; // Precio base de ejemplo
    if (pieceDto.screen) calculatedPrice += 20;
    if (pieceDto.muntin) calculatedPrice += 15;
    return calculatedPrice;
  }
}
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Piece, Prisma } from '@prisma/client';

@Injectable()
export class PiecesService {
  constructor(private prisma: PrismaService) { }

  /**
   * Encuentra una única pieza por su ID.
   * Lanza un error 404 si no se encuentra.
   */
  async piece(
    pieceWhereUniqueInput: Prisma.PieceWhereUniqueInput
  ): Promise<Piece> {
    const piece = await this.prisma.piece.findUnique({
      where: pieceWhereUniqueInput,
    });

    if (!piece) {
      throw new NotFoundException(`Piece with ID #${pieceWhereUniqueInput.id} not found.`);
    }
    return piece;
  }

  /**
   * Encuentra una lista de piezas, con opciones para paginación y filtrado.
   */
  async pieces(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.PieceWhereUniqueInput;
    where?: Prisma.PieceWhereInput;
    orderBy?: Prisma.PieceOrderByWithRelationInput;
  }): Promise<Piece[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.piece.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }
}
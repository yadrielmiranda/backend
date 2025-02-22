import { Injectable } from '@nestjs/common';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { Piece, Prisma } from '@prisma/client';

@Injectable()
export class PiecesService {
  constructor(private prisma: PrismaService) { }

  async piece(
    pieceWhereUniqueInput: Prisma.PieceWhereUniqueInput
  ): Promise<Piece | null> {
    return this.prisma.piece.findUnique({
      where: pieceWhereUniqueInput,
    });
  }

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

  async createPiece(data: Prisma.PieceCreateInput): Promise<Piece> {
    return this.prisma.piece.create({
      data,
    });
  }

  async updatePiece(params: {
    where: Prisma.PieceWhereUniqueInput;
    data: UpdatePieceDto;
  }): Promise<Piece> {
    const { where, data } = params;
    return this.prisma.piece.update({
      data,
      where
    });
  }

  async deletePiece(where: Prisma.PieceWhereUniqueInput): Promise<Piece> {
    return this.prisma.piece.delete({
      where,
    });
  }
}

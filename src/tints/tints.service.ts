import { Injectable } from '@nestjs/common';
import { Prisma, Tint } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class TintsService {

  constructor(private prisma: PrismaService) { }

  async tint(
    tintWhereUniqueInput: Prisma.TintWhereUniqueInput
  ): Promise<Tint | null> {
    return this.prisma.tint.findUnique({
      where: tintWhereUniqueInput,
    });
  }

  async tints(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.TintWhereUniqueInput;
    where?: Prisma.TintWhereInput;
    orderBy?: Prisma.TintOrderByWithRelationInput;
  }): Promise<Tint[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.tint.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createTint(data: Prisma.TintCreateInput): Promise<Tint> {
    return this.prisma.tint.create({
      data,
    });
  }

  async updateTint(params: {
    where: Prisma.TintWhereUniqueInput;
    data: Prisma.TintUpdateInput;
  }): Promise<Tint> {
    const { where, data } = params;
    return this.prisma.tint.update({
      data,
      where
    });
  }

  async deleteTint(where: Prisma.TintWhereUniqueInput): Promise<Tint> {
    return this.prisma.tint.delete({
      where,
    });
  }
}

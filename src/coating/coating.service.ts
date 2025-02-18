import { Injectable } from '@nestjs/common';
import { Prisma, Coating } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CoatingService {
  constructor(private prisma: PrismaService) { }

  async coating(
    coatingWhereUniqueInput: Prisma.CoatingWhereUniqueInput
  ): Promise<Coating | null> {
    return this.prisma.coating.findUnique({
      where: coatingWhereUniqueInput,
    });
  }

  async coatings(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.CoatingWhereUniqueInput;
    where?: Prisma.CoatingWhereInput;
    orderBy?: Prisma.CoatingOrderByWithRelationInput;
  }): Promise<Coating[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.coating.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createCoating(data: Prisma.CoatingCreateInput): Promise<Coating> {
    return this.prisma.coating.create({
      data,
    });
  }

  async updateCoating(params: {
    where: Prisma.CoatingWhereUniqueInput;
    data: Prisma.CoatingUpdateInput;
  }): Promise<Coating> {
    const { where, data } = params;
    return this.prisma.coating.update({
      data,
      where
    });
  }

  async deleteCoating(where: Prisma.CoatingWhereUniqueInput): Promise<Coating> {
    return this.prisma.coating.delete({
      where,
    });
  }
}

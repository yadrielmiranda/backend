import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tint } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class TintService {
  constructor(private prisma: PrismaService) { }

  async tint(
    tintWhereUniqueInput: Prisma.TintWhereUniqueInput
  ): Promise<Tint> {
    const tint = await this.prisma.tint.findUnique({
      where: tintWhereUniqueInput,
    });

    if (!tint) {
      throw new NotFoundException(
        `Tint with ID #${tintWhereUniqueInput.id} not found`,
      );
    }
    return tint;
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
    try {
      return await this.prisma.tint.update({
        data,
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Tint with ID #${where.id} not found`);
    }
  }

  async deleteTint(where: Prisma.TintWhereUniqueInput): Promise<Tint> {
    try {
      return await this.prisma.tint.delete({
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Tint with ID #${where.id} not found`);
    }
  }
}

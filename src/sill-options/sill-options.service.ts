import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SillOption } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class SillOptionsService {
  constructor(private prisma: PrismaService) {}

  async sillOption(where: Prisma.SillOptionWhereUniqueInput): Promise<SillOption> {
    const sillOption = await this.prisma.sillOption.findUnique({
      where,
    });

    if (!sillOption) {
      throw new NotFoundException(`SillOption with ID #${where.id} not found.`);
    }

    return sillOption;
  }

  async sillOptions(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SillOptionWhereUniqueInput;
    where?: Prisma.SillOptionWhereInput;
    orderBy?: Prisma.SillOptionOrderByWithRelationInput;
  }): Promise<SillOption[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.sillOption.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createSillOption(data: Prisma.SillOptionCreateInput): Promise<SillOption> {
    return this.prisma.sillOption.create({
      data,
    });
  }

  async updateSillOption(params: {
    where: Prisma.SillOptionWhereUniqueInput;
    data: Prisma.SillOptionUpdateInput;
  }): Promise<SillOption> {
    const { where, data } = params;

    try {
      return await this.prisma.sillOption.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`SillOption with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteSillOption(where: Prisma.SillOptionWhereUniqueInput): Promise<SillOption> {
    try {
      return await this.prisma.sillOption.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`SillOption with ID #${where.id} not found.`);
      }
      throw e;
    }
  }
}
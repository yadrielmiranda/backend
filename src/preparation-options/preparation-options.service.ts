import { Injectable, NotFoundException } from '@nestjs/common';
import { PreparationOption, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class PreparationOptionsService {
  constructor(private prisma: PrismaService) {}

  async preparationOption(
    where: Prisma.PreparationOptionWhereUniqueInput,
  ): Promise<PreparationOption> {
    const preparationOption = await this.prisma.preparationOption.findUnique({
      where,
    });

    if (!preparationOption) {
      throw new NotFoundException(
        `PreparationOption with ID #${where.id} not found.`,
      );
    }

    return preparationOption;
  }

  async preparationOptions(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.PreparationOptionWhereUniqueInput;
    where?: Prisma.PreparationOptionWhereInput;
    orderBy?: Prisma.PreparationOptionOrderByWithRelationInput;
  }): Promise<PreparationOption[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.preparationOption.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createPreparationOption(
    data: Prisma.PreparationOptionCreateInput,
  ): Promise<PreparationOption> {
    return this.prisma.preparationOption.create({
      data,
    });
  }

  async updatePreparationOption(params: {
    where: Prisma.PreparationOptionWhereUniqueInput;
    data: Prisma.PreparationOptionUpdateInput;
  }): Promise<PreparationOption> {
    const { where, data } = params;

    try {
      return await this.prisma.preparationOption.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `PreparationOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }

  async deletePreparationOption(
    where: Prisma.PreparationOptionWhereUniqueInput,
  ): Promise<PreparationOption> {
    try {
      return await this.prisma.preparationOption.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `PreparationOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }
}
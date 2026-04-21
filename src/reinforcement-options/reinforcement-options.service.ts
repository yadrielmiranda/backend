import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReinforcementOption } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class ReinforcementOptionsService {
  constructor(private prisma: PrismaService) {}

  async reinforcementOption(
    where: Prisma.ReinforcementOptionWhereUniqueInput,
  ): Promise<ReinforcementOption> {
    const reinforcementOption = await this.prisma.reinforcementOption.findUnique({
      where,
    });

    if (!reinforcementOption) {
      throw new NotFoundException(
        `ReinforcementOption with ID #${where.id} not found.`,
      );
    }

    return reinforcementOption;
  }

  async reinforcementOptions(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.ReinforcementOptionWhereUniqueInput;
    where?: Prisma.ReinforcementOptionWhereInput;
    orderBy?: Prisma.ReinforcementOptionOrderByWithRelationInput;
  }): Promise<ReinforcementOption[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.reinforcementOption.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createReinforcementOption(
    data: Prisma.ReinforcementOptionCreateInput,
  ): Promise<ReinforcementOption> {
    return this.prisma.reinforcementOption.create({
      data,
    });
  }

  async updateReinforcementOption(params: {
    where: Prisma.ReinforcementOptionWhereUniqueInput;
    data: Prisma.ReinforcementOptionUpdateInput;
  }): Promise<ReinforcementOption> {
    const { where, data } = params;

    try {
      return await this.prisma.reinforcementOption.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `ReinforcementOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }

  async deleteReinforcementOption(
    where: Prisma.ReinforcementOptionWhereUniqueInput,
  ): Promise<ReinforcementOption> {
    try {
      return await this.prisma.reinforcementOption.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `ReinforcementOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }
}
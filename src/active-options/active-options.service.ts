import { Injectable, NotFoundException } from '@nestjs/common';
import { ActiveOption, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class ActiveOptionsService {
  constructor(private prisma: PrismaService) {}

  async activeOption(
    where: Prisma.ActiveOptionWhereUniqueInput,
  ): Promise<ActiveOption> {
    const activeOption = await this.prisma.activeOption.findUnique({
      where,
    });

    if (!activeOption) {
      throw new NotFoundException(
        `ActiveOption with ID #${where.id} not found.`,
      );
    }

    return activeOption;
  }

  async activeOptions(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.ActiveOptionWhereUniqueInput;
    where?: Prisma.ActiveOptionWhereInput;
    orderBy?: Prisma.ActiveOptionOrderByWithRelationInput;
  }): Promise<ActiveOption[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.activeOption.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createActiveOption(
    data: Prisma.ActiveOptionCreateInput,
  ): Promise<ActiveOption> {
    return this.prisma.activeOption.create({
      data,
    });
  }

  async updateActiveOption(params: {
    where: Prisma.ActiveOptionWhereUniqueInput;
    data: Prisma.ActiveOptionUpdateInput;
  }): Promise<ActiveOption> {
    const { where, data } = params;

    try {
      return await this.prisma.activeOption.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `ActiveOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }

  async deleteActiveOption(
    where: Prisma.ActiveOptionWhereUniqueInput,
  ): Promise<ActiveOption> {
    try {
      return await this.prisma.activeOption.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `ActiveOption with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }
}
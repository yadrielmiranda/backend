import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Config, Prisma } from '@prisma/client';

@Injectable()
export class ConfigSService {
  constructor(private prisma: PrismaService) {}

  async config(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    const config = await this.prisma.config.findUnique({
      where,
      include: { prod: true },
    });

    if (!config) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }
    return config;
  }

  async configs(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.ConfigWhereUniqueInput;
    where?: Prisma.ConfigWhereInput;
    orderBy?: Prisma.ConfigOrderByWithRelationInput;
  }): Promise<Config[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.config.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      include: { prod: true },
    });
  }

  async createConfig(data: Prisma.ConfigCreateInput): Promise<Config> {
    return this.prisma.config.create({
      data,
      include: { prod: true },
    });
  }

  async updateConfig(params: {
    where: Prisma.ConfigWhereUniqueInput;
    data: Prisma.ConfigUpdateInput;
  }): Promise<Config> {
    const { where, data } = params;

    try {
      return await this.prisma.config.update({
        data,
        where,
        include: { prod: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Config with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteConfig(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    try {
      return await this.prisma.config.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Config with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async getConfigWithProduct(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    const config = await this.prisma.config.findUnique({
      where,
      include: { prod: true },
    });

    if (!config) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }
    return config;
  }
}
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Config, Prisma } from '@prisma/client';

@Injectable()
export class ConfigSService {
  constructor(private prisma: PrismaService) { }

  async config(
    configWhereUniqueInput: Prisma.ConfigWhereUniqueInput
  ): Promise<Config> {
    const config = await this.prisma.config.findUnique({
      where: configWhereUniqueInput,
    });

    if (!config) {
      throw new NotFoundException(`Config with ID #${configWhereUniqueInput.id} not found.`);
    }
    return config;
  }

  async configs(params: {
    // ... tus parámetros ...
  }): Promise<Config[]> {
    // ... tu lógica findMany ...
    return this.prisma.config.findMany({
      ...params,
      include: {
        prod: true,
      },
    });
  }

  async createConfig(data: Prisma.ConfigCreateInput): Promise<Config> {
    return this.prisma.config.create({
      data,
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
      });
    } catch (error) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }
  }

  async deleteConfig(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    try {
      return await this.prisma.config.delete({
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Config with ID #${where.id} not found.`);
    }
  }

  
  async getConfigWithProduct(
    configWhereUniqueInput: Prisma.ConfigWhereUniqueInput
  ): Promise<Config | null> {
    const config = await this.prisma.config.findUnique({
      where: configWhereUniqueInput,
      include: {
        prod: true,
      },
    });

    if (!config) {
        throw new NotFoundException(`Config with ID #${configWhereUniqueInput.id} not found.`);
    }
    return config;
  }
}
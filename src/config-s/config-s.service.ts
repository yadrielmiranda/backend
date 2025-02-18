import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Config, Prisma } from '@prisma/client';

@Injectable()
export class ConfigSService {
  constructor(private prisma: PrismaService) { }


  async config(
    configWhereUniqueInput: Prisma.ConfigWhereUniqueInput
  ): Promise<Config | null> {
    return this.prisma.config.findUnique({
      where: configWhereUniqueInput,
    });
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
    return this.prisma.config.update({
      data,
      where
    });
  }

  async deleteConfig(where: Prisma.ConfigWhereUniqueInput): Promise<Config> {
    return this.prisma.config.delete({
      where,
    });
  }

}

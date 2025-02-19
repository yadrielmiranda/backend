import { Injectable } from '@nestjs/common';
import { Prisma, SysConf } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';


@Injectable()
export class SystemConfigService {
  constructor(private prisma: PrismaService) { }

  async sysConf(
    sysConfWhereUniqueInput: Prisma.SysConfWhereUniqueInput
  ): Promise<SysConf | null> {
    return this.prisma.sysConf.findUnique({
      where: sysConfWhereUniqueInput,
    });
  }

  async sysConfs(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SysConfWhereUniqueInput;
    where?: Prisma.SysConfWhereInput;
    orderBy?: Prisma.SysConfOrderByWithRelationInput;
  }): Promise<SysConf[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.sysConf.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createSysConf(data: Prisma.SysConfCreateInput): Promise<SysConf> {
    return this.prisma.sysConf.create({
      data,
    });
  }

  async updateSysConf(params: {
    where: Prisma.SysConfWhereUniqueInput;
    data: UpdateSystemConfigDto;
  }): Promise<SysConf> {
    const { where, data } = params;
    return this.prisma.sysConf.update({
      data,
      where
    });
  }

  async deleteSysConf(where: Prisma.SysConfWhereUniqueInput): Promise<SysConf> {
    return this.prisma.sysConf.delete({
      where,
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, System } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateSystemDto } from './dto/update-system.dto';

@Injectable()
export class SystemsService {

  constructor(private prisma: PrismaService) { } 

  async system(
    systemWhereUniqueInput: Prisma.SystemWhereUniqueInput
  ): Promise<System | null> {
    return this.prisma.system.findUnique({
      where: systemWhereUniqueInput,
    });
  }

  async systems(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SystemWhereUniqueInput;
    where?: Prisma.SystemWhereInput;
    orderBy?: Prisma.SystemOrderByWithRelationInput;
  }): Promise<System[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.system.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createSystem(data: Prisma.SystemCreateInput): Promise<System> {
    return this.prisma.system.create({
      data,
    });
  }

  async updateSystem(params: {
    where: Prisma.SystemWhereUniqueInput;
    data: UpdateSystemDto;
  }): Promise<System> {
    const { where, data } = params;
    return this.prisma.system.update({
      data,
      where
    });
  }

  async deleteSystem(where: Prisma.SystemWhereUniqueInput): Promise<System> {
    return this.prisma.system.delete({
      where
    });
  }



}

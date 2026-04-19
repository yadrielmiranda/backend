import { Injectable, NotFoundException } from '@nestjs/common';
import { MuntinType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateMuntinTypeDto } from './dto/create-muntin-type.dto';
import { UpdateMuntinTypeDto } from './dto/update-muntin-type.dto';

@Injectable()
export class MuntinTypesService {
  constructor(private prisma: PrismaService) {}

  async muntinType(
    where: Prisma.MuntinTypeWhereUniqueInput,
  ): Promise<MuntinType> {
    const type = await this.prisma.muntinType.findUnique({ where });

    if (!type) {
      throw new NotFoundException(`MuntinType with ID #${where.id} not found.`);
    }

    return type;
  }

  async muntinTypes(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.MuntinTypeWhereUniqueInput;
    where?: Prisma.MuntinTypeWhereInput;
    orderBy?: Prisma.MuntinTypeOrderByWithRelationInput;
  }): Promise<MuntinType[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.muntinType.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createMuntinType(data: CreateMuntinTypeDto): Promise<MuntinType> {
    return this.prisma.muntinType.create({
      data: {
        name: data.name.trim(),
        isActive: data.isActive ?? true,
      },
    });
  }

  async updateMuntinType(params: {
    where: Prisma.MuntinTypeWhereUniqueInput;
    data: UpdateMuntinTypeDto;
  }): Promise<MuntinType> {
    const { where, data } = params;

    try {
      return await this.prisma.muntinType.update({
        where,
        data: {
          ...(data.name !== undefined ? { name: data.name.trim() } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`MuntinType with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteMuntinType(
    where: Prisma.MuntinTypeWhereUniqueInput,
  ): Promise<MuntinType> {
    try {
      return await this.prisma.muntinType.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`MuntinType with ID #${where.id} not found.`);
      }
      throw e;
    }
  }
}
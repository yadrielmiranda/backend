import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Crystal } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CrystalService {
  constructor(private prisma: PrismaService) {}

  async crystal(where: Prisma.CrystalWhereUniqueInput): Promise<Crystal> {
    const crystal = await this.prisma.crystal.findUnique({ where });

    if (!crystal) {
      throw new NotFoundException(`Crystal with ID #${where.id} not found.`);
    }
    return crystal;
  }

  async crystals(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.CrystalWhereUniqueInput;
    where?: Prisma.CrystalWhereInput;
    orderBy?: Prisma.CrystalOrderByWithRelationInput;
  }): Promise<Crystal[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.crystal.findMany({ skip, take, cursor, where, orderBy });
  }

  async createCrystal(data: Prisma.CrystalCreateInput): Promise<Crystal> {
    return this.prisma.crystal.create({ data });
  }

  async updateCrystal(params: {
    where: Prisma.CrystalWhereUniqueInput;
    data: Prisma.CrystalUpdateInput;
  }): Promise<Crystal> {
    const { where, data } = params;

    try {
      return await this.prisma.crystal.update({ data, where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Crystal with ID #${where.id} not found.`);
      }
      throw e;
    }
  }

  async deleteCrystal(where: Prisma.CrystalWhereUniqueInput): Promise<Crystal> {
    try {
      return await this.prisma.crystal.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Crystal with ID #${where.id} not found.`);
      }
      throw e;
    }
  }
}

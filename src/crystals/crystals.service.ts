import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Crystal, Prisma } from '@prisma/client';

@Injectable()
export class CrystalsService {

  constructor(private prisma: PrismaService) { }

  async crystal(
    crystalWhereUniqueInput: Prisma.CrystalWhereUniqueInput
  ): Promise<Crystal | null> {
    return this.prisma.crystal.findUnique({
      where: crystalWhereUniqueInput,
    });
  }

  async crystals(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.CrystalWhereUniqueInput;
    where?: Prisma.CrystalWhereInput;
    orderBy?: Prisma.CrystalOrderByWithRelationInput;
  }): Promise<Crystal[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.crystal.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createCrystal(data: Prisma.CrystalCreateInput): Promise<Crystal> {
    return this.prisma.crystal.create({
      data,
    });
  }

  async updateCrystal(params: {
    where: Prisma.CrystalWhereUniqueInput;
    data: Prisma.CrystalUpdateInput;
  }): Promise<Crystal> {
    const { where, data } = params;
    return this.prisma.crystal.update({
      data,
      where
    });
  }

  async deleteCrystal(where: Prisma.CrystalWhereUniqueInput): Promise<Crystal> {
    return this.prisma.crystal.delete({
      where,
    });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Brand, Prisma } from '@prisma/client';

@Injectable()
export class BrandsService {

  constructor(private prisma: PrismaService) { }

  async brand(
    brandWhereUniqueInput: Prisma.BrandWhereUniqueInput
  ): Promise<Brand | null> {
    return this.prisma.brand.findUnique({
      where: brandWhereUniqueInput,
    });
  }

  async brands(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.BrandWhereUniqueInput;
    where?: Prisma.BrandWhereInput;
    orderBy?: Prisma.BrandOrderByWithRelationInput;
  }): Promise<Brand[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.brand.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createBrand(data: Prisma.BrandCreateInput): Promise<Brand> {
    return this.prisma.brand.create({
      data,
    });
  }

  async updateBrand(params: {
    where: Prisma.BrandWhereUniqueInput;
    data: Prisma.BrandUpdateInput;
  }): Promise<Brand> {
    const { where, data } = params;
    return this.prisma.brand.update({
      data,
      where
    });
  }

  async deleteBrand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    return this.prisma.brand.delete({
      where,
    });
  }
}

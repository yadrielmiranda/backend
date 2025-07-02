import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Brand, Prisma } from '@prisma/client';

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) { }

  async brand(
    brandWhereUniqueInput: Prisma.BrandWhereUniqueInput
  ): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where: brandWhereUniqueInput,
    });
    if (!brand) {
      throw new NotFoundException(`Brand with ID #${brandWhereUniqueInput.id} not found`);
    }
    return brand;
  }

  async brands(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.BrandWhereUniqueInput;
    where?: Prisma.BrandWhereInput;
    orderBy?: Prisma.BrandOrderByWithRelationInput;
  }): Promise<Brand[]> {
    return this.prisma.brand.findMany(params);
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
    try {
      return await this.prisma.brand.update({
        data,
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Brand with ID #${where.id} not found`);
    }
  }

  async deleteBrand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    try {
      return await this.prisma.brand.delete({
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Brand with ID #${where.id} not found`);
    }
  }

  async getBrandWithProducts(
    brandWhereUniqueInput: Prisma.BrandWhereUniqueInput
  ): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where: brandWhereUniqueInput,
      include: {
        brandProducts: {
          include: {
            product: true,
          },
        },
      },
    });
    if (!brand) {
      throw new NotFoundException(`Brand with ID #${brandWhereUniqueInput.id} not found`);
    }
    return brand;
  }

  async addProductToBrand(brandId: number, productId: number): Promise<Brand> {
    return this.prisma.brand.update({
      where: { id: brandId },
      data: {
        brandProducts: {
          create: {
            idProduct: productId,
          },
        },
      },
      include: {
        brandProducts: {
          include: { product: true },
        },
      },
    });
  }

  async removeProductFromBrand(brandId: number, productId: number): Promise<Brand> {
    return this.prisma.brand.update({
      where: { id: brandId },
      data: {
        brandProducts: {          
          delete: {
            idBrand_idProduct: {
              idBrand: brandId,
              idProduct: productId,
            },
          },
        },
      },
      include: {
        brandProducts: {
          include: { product: true },
        },
      },
    });
  }
}

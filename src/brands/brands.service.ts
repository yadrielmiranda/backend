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


  // Obtener los productos asociados a una marca
  async getBrandwithProducts(
  brandWhereUniqueInput: Prisma.BrandWhereUniqueInput
): Promise<Brand | null> {
  return this.prisma.brand.findUnique({
    where: brandWhereUniqueInput,
    include: {
      brandProducts: { // Incluye las entradas de la tabla de unión
        include: { // Y también incluye los detalles reales del producto a través de la tabla de unión
          product: true,
        },
      },
    },
  });
}

// Este método te permite vincular un producto existente a una marca existente

async addProductToBrand(brandId: number, productId: number): Promise<Brand> {
  
  return this.prisma.brand.update({
    where: { id: brandId }, // Actualiza la marca específica
    data: {
      brandProducts: {
        create: {
          idProduct: productId, // Crea una nueva entrada en BrandProduct
        },
      },
    },
    include: {
      brandProducts: {
        include: { product: true }, // Incluye la asociación actualizada en la respuesta
      },
    },
  });
}


// Este método te permite eliminar un vínculo entre un producto y una marca.
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

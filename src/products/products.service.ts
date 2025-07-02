import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, Product } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) { }

  async product(
    productWhereUniqueInput: Prisma.ProductWhereUniqueInput
  ): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where: productWhereUniqueInput,
    });

    if (!product) {
      throw new NotFoundException(
        `Product with ID #${productWhereUniqueInput.id} not found`,
      );
    }
    return product;
  }

  async products(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.ProductWhereUniqueInput;
    where?: Prisma.ProductWhereInput;
    orderBy?: Prisma.ProductOrderByWithRelationInput;
  }): Promise<Product[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.product.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createProduct(data: Prisma.ProductCreateInput): Promise<Product> {
    return this.prisma.product.create({
      data,
    });
  }

  async updateProduct(params: {
    where: Prisma.ProductWhereUniqueInput;
    data: Prisma.ProductUpdateInput;
  }): Promise<Product> {
    const { where, data } = params;
    try {
      return await this.prisma.product.update({
        data,
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Product with ID #${where.id} not found`);
    }
  }

  async deleteProduct(where: Prisma.ProductWhereUniqueInput): Promise<Product> {
    try {
      return await this.prisma.product.delete({
        where,
      });
    } catch (error) {
      throw new NotFoundException(`Product with ID #${where.id} not found`);
    }
  }
}

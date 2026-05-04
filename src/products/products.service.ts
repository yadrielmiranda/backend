import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { Prisma, Product } from "@prisma/client";

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async product(where: Prisma.ProductWhereUniqueInput): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where,
    });

    if (!product) {
      throw new NotFoundException(`Product with ID #${where.id} not found`);
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
    const take = clampInt(params.take, 50, 1, 100);
    const skip = clampInt(params.skip, 0, 0, 10_000);

    return this.prisma.product.findMany({
      skip,
      take,
      cursor: params.cursor,
      where: params.where,
      orderBy: params.orderBy ?? { name: "asc" },
    });
  }

  async createProduct(data: Prisma.ProductCreateInput): Promise<Product> {
    try {
      return await this.prisma.product.create({
        data: {
          ...data,
          isActive: data.isActive ?? true,
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Product already exists.");
      }

      throw e;
    }
  }

  async updateProduct(params: {
    where: Prisma.ProductWhereUniqueInput;
    data: Prisma.ProductUpdateInput;
  }): Promise<Product> {
    const { where, data } = params;

    try {
      return await this.prisma.product.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Product with ID #${where.id} not found`);
      }

      if (e?.code === "P2002") {
        throw new ConflictException("Product name already exists.");
      }

      throw e;
    }
  }

  async deleteProduct(where: Prisma.ProductWhereUniqueInput): Promise<Product> {
    try {
      return await this.prisma.product.delete({
        where,
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Product with ID #${where.id} not found`);
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This product is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }

  async findAllWithBrands(opts?: { take?: number; skip?: number }): Promise<Product[]> {
    const take = clampInt(opts?.take, 100, 1, 200);
    const skip = clampInt(opts?.skip, 0, 0, 10_000);

    return this.prisma.product.findMany({
      include: {
        brandProducts: {
          include: { brand: true },
        },
      },
      orderBy: { id: "asc" },
      take,
      skip,
    });
  }
}
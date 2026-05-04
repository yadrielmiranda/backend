import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { Brand, Prisma } from "@prisma/client";

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) { }

  private async assertBrandExists(id: number) {
    const b = await this.prisma.brand.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!b) throw new NotFoundException(`Brand with ID #${id} not found.`);
  }

  private async assertProductExists(id: number) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!p) throw new NotFoundException(`Product with ID #${id} not found.`);
  }

  async brand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({ where });

    if (!brand) {
      throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
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
    const take = clampInt(params.take, 50, 1, 100);
    const skip = clampInt(params.skip, 0, 0, 10_000);

    return this.prisma.brand.findMany({
      skip,
      take,
      cursor: params.cursor,
      where: params.where,
      orderBy: params.orderBy ?? { name: "asc" },
    });
  }

  async createBrand(data: Prisma.BrandCreateInput): Promise<Brand> {
    try {
      return await this.prisma.brand.create({
        data: {
          ...data,
          isActive: data.isActive ?? true,
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Brand already exists.");
      }

      throw e;
    }
  }

  async updateBrand(params: {
    where: Prisma.BrandWhereUniqueInput;
    data: Prisma.BrandUpdateInput;
  }): Promise<Brand> {
    const { where, data } = params;

    try {
      return await this.prisma.brand.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
      }

      if (e?.code === "P2002") {
        throw new ConflictException("Brand name already exists.");
      }

      throw e;
    }
  }

  async deleteBrand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    try {
      return await this.prisma.brand.delete({ where });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This brand is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }

  async getBrandWithProducts(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where,
      include: {
        brandProducts: {
          include: { product: true },
        },
      },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
    }

    return brand;
  }

  async findAllWithProducts(opts?: { take?: number; skip?: number }): Promise<Brand[]> {
    const take = clampInt(opts?.take, 50, 1, 100);
    const skip = clampInt(opts?.skip, 0, 0, 10_000);

    return this.prisma.brand.findMany({
      take,
      skip,
      orderBy: { name: "asc" },
      include: {
        brandProducts: {
          include: { product: true },
        },
      },
    });
  }

  async getAvailableProductsForBrand(brandId: number) {
    await this.assertBrandExists(brandId);

    const associatedProducts = await this.prisma.brandProduct.findMany({
      where: { idBrand: brandId },
      select: { idProduct: true },
    });

    const associatedProductIds = associatedProducts.map((x) => x.idProduct);

    return this.prisma.product.findMany({
      where: {
        isActive: true,
        id: associatedProductIds.length
          ? { notIn: associatedProductIds }
          : undefined,
      },
      orderBy: { name: "asc" },
    });
  }

  async addProductToBrand(brandId: number, productId: number): Promise<Brand> {
    await this.assertBrandExists(brandId);
    await this.assertProductExists(productId);

    try {
      return await this.prisma.brand.update({
        where: { id: brandId },
        data: {
          brandProducts: {
            create: { idProduct: productId },
          },
        },
        include: {
          brandProducts: {
            include: { product: true },
          },
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("This product is already linked to the brand.");
      }

      throw e;
    }
  }

  async removeProductFromBrand(brandId: number, productId: number): Promise<Brand> {
    await this.assertBrandExists(brandId);
    await this.assertProductExists(productId);

    try {
      return await this.prisma.brand.update({
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
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException("Brand-product link not found.");
      }

      throw e;
    }
  }
}
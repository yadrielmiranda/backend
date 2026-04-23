import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Brand, Prisma } from '@prisma/client';

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  // ✅ helper: asegurar Brand existe (comentario en español)
  private async assertBrandExists(id: number) {
    const b = await this.prisma.brand.findUnique({ where: { id }, select: { id: true } });
    if (!b) throw new NotFoundException(`Brand with ID #${id} not found.`);
  }

  // ✅ helper: asegurar Product existe
  private async assertProductExists(id: number) {
    const p = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });
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
    // ✅ límites pro para evitar abuso
    const take = clampInt(params.take, 50, 1, 100);
    const skip = clampInt(params.skip, 0, 0, 10_000);

    return this.prisma.brand.findMany({
      ...params,
      take,
      skip,
      orderBy: params.orderBy ?? { name: 'asc' },
    });
  }

  async createBrand(data: Prisma.BrandCreateInput): Promise<Brand> {
    try {
      return await this.prisma.brand.create({ data });
    } catch (e: any) {
      // Si name es unique en schema, Prisma lanza P2002
      if (e?.code === 'P2002') {
        throw new ConflictException('Brand already exists.');
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
      return await this.prisma.brand.update({ where, data });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
      }
      if (e?.code === 'P2002') {
        throw new ConflictException('Brand name already exists.');
      }
      throw e;
    }
  }

  async deleteBrand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    try {
      return await this.prisma.brand.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Brand with ID #${(where as any)?.id} not found.`);
      }
      throw e;
    }
  }

  async getBrandWithProducts(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where,
      include: {
        brandProducts: { include: { product: true } },
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
      orderBy: { name: 'asc' },
      include: {
        brandProducts: { include: { product: true } },
      },
    });
  }

  async addProductToBrand(brandId: number, productId: number): Promise<Brand> {
    // ✅ validaciones explícitas (más claro que depender de errores internos)
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
        include: { brandProducts: { include: { product: true } } },
      });
    } catch (e: any) {
      // relación duplicada (si la tabla puente tiene unique compuesto)
      if (e?.code === 'P2002') {
        throw new ConflictException('This product is already linked to the brand.');
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
              idBrand_idProduct: { idBrand: brandId, idProduct: productId },
            },
          },
        },
        include: { brandProducts: { include: { product: true } } },
      });
    } catch (e: any) {
      // P2025: no existe la relación a borrar
      if (e?.code === 'P2025') {
        throw new NotFoundException('Brand-product link not found.');
      }
      throw e;
    }
  }
}

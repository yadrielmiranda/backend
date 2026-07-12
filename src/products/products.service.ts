// src/products/products.service.ts

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { PricingMode, Prisma, Product, ProductKind } from "@prisma/client";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);

  if (!Number.isFinite(n)) {
    return def;
  }

  return Math.min(Math.max(n, min), max);
}

function normalizeProductClassification(data: {
  kind?: ProductKind;
  pricingMode?: PricingMode;
}) {
  const kind = data.kind ?? ProductKind.GLAZED_UNIT;

  const pricingMode =
    data.pricingMode ??
    (kind === ProductKind.LINEAR_MATERIAL
      ? PricingMode.LINEAR_INCH
      : PricingMode.AREA_PERIMETER);

  if (
    kind === ProductKind.GLAZED_UNIT &&
    pricingMode !== PricingMode.AREA_PERIMETER
  ) {
    throw new BadRequestException(
      "GLAZED_UNIT products must use AREA_PERIMETER pricing mode.",
    );
  }

  if (
    kind === ProductKind.LINEAR_MATERIAL &&
    pricingMode !== PricingMode.LINEAR_INCH
  ) {
    throw new BadRequestException(
      "LINEAR_MATERIAL products must use LINEAR_INCH pricing mode.",
    );
  }

  return { kind, pricingMode };
}

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) { }

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

  async createProduct(data: CreateProductDto): Promise<Product> {
    const classification = normalizeProductClassification({
      kind: data.kind,
      pricingMode: data.pricingMode,
    });

    try {
      return await this.prisma.product.create({
        data: {
          name: data.name,
          isActive: true,
          diagramFamily: data.diagramFamily,
          ...classification,
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
    data: UpdateProductDto;
  }): Promise<Product> {
    const { where, data } = params;

    const current = await this.prisma.product.findUnique({
      where,
      select: {
        id: true,
        kind: true,
        pricingMode: true,
      },
    });

    if (!current) {
      throw new NotFoundException(`Product with ID #${where.id} not found`);
    }

    const nextKind = data.kind ?? current.kind;
    const nextPricingMode = data.pricingMode ?? current.pricingMode;

    const classification = normalizeProductClassification({
      kind: nextKind,
      pricingMode: nextPricingMode,
    });

    try {
      return await this.prisma.product.update({
        where,
        data: {
          name: data.name,
          isActive: data.isActive,
          diagramFamily: data.diagramFamily,
          ...classification,
        },
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

  async deleteProduct(
    where: Prisma.ProductWhereUniqueInput,
  ): Promise<Product> {
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

  async findAllWithBrands(opts?: {
    take?: number;
    skip?: number;
  }): Promise<Product[]> {
    const take = clampInt(opts?.take, 100, 1, 200);
    const skip = clampInt(opts?.skip, 0, 0, 10_000);

    return this.prisma.product.findMany({
      include: {
        brandProducts: {
          include: {
            brand: true,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
      take,
      skip,
    });
  }
}
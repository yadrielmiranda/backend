import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { Brand, Prisma } from "@prisma/client";
import { UpdateBrandCoatingsDto } from "./dto/update-brand-coatings.dto";
import { UpdateBrandPrivaciesDto } from "./dto/update-brand-privacies.dto";
import { UpdateBrandTintsDto } from "./dto/update-brand-tints.dto";

function clampInt(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

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

  async getBrandTintsForManage(brandId: number) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, name: true },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with ID #${brandId} not found.`);
    }

    const [catalog, associations] = await Promise.all([
      this.prisma.tint.findMany({
        orderBy: [
          { isActive: "desc" },
          { globalSortOrder: "asc" },
          { color: "asc" },
          { id: "asc" },
        ],
      }),
      this.prisma.brandTint.findMany({ where: { idBrand: brandId } }),
    ]);

    const associationById = new Map(
      associations.map((association) => [association.idTint, association]),
    );

    const tints = catalog.map((tint) => {
      const association = associationById.get(tint.id);

      return {
        ...tint,
        isAssociated: Boolean(association),
        sortOrder: association?.sortOrder ?? null,
        surchargeEnabled: association?.surchargeEnabled ?? false,
        isDefault: association?.isDefault ?? false,
        costoA: association?.costoA ?? null,
        costoB: association?.costoB ?? null,
        costoC: association?.costoC ?? null,
      };
    });

    tints.sort((left, right) => {
      if (left.isAssociated !== right.isAssociated) {
        return left.isAssociated ? -1 : 1;
      }

      if (left.isAssociated && right.isAssociated) {
        const orderDifference = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
        if (orderDifference !== 0) return orderDifference;
      }

      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      return left.color.localeCompare(right.color) || left.id - right.id;
    });

    return {
      brand,
      tints,
    };
  }

  async updateBrandTints(brandId: number, data: UpdateBrandTintsDto) {
    await this.assertBrandExists(brandId);

    if (data.tints.length === 0) {
      throw new ConflictException(
        "A Brand must have at least one available Tint.",
      );
    }

    const tintIds = data.tints.map((item) => item.tintId);
    const existingTints = await this.prisma.tint.findMany({
      where: { id: { in: tintIds } },
      select: { id: true, isActive: true },
    });

    if (existingTints.length !== tintIds.length) {
      const existingIds = new Set(existingTints.map((tint) => tint.id));
      const missingId = tintIds.find((id) => !existingIds.has(id));
      throw new NotFoundException(`Tint with ID #${missingId} not found.`);
    }

    const defaults = data.tints.filter((item) => item.isDefault);

    if (defaults.length !== 1) {
      throw new ConflictException(
        "Select exactly one default Tint for this Brand.",
      );
    }

    const activeTintIds = new Set(
      existingTints.filter((tint) => tint.isActive).map((tint) => tint.id),
    );

    if (!activeTintIds.has(defaults[0].tintId)) {
      throw new ConflictException("The default Tint must be active.");
    }

    const normalized = data.tints.map((item, index) => {
      const sortOrder = item.sortOrder ?? index;

      if (!item.surchargeEnabled) {
        return {
          idBrand: brandId,
          idTint: item.tintId,
          sortOrder,
          surchargeEnabled: false,
          isDefault: item.isDefault,
          costoA: null,
          costoB: null,
          costoC: null,
        };
      }

      const coefficients = [item.costoA, item.costoB, item.costoC];

      if (
        coefficients.some(
          (value) =>
            value == null ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0,
        )
      ) {
        throw new ConflictException(
          "Tint surcharge Area Cost, Perimeter Cost and Fixed Cost are required and must be zero or greater.",
        );
      }

      return {
        idBrand: brandId,
        idTint: item.tintId,
        sortOrder,
        surchargeEnabled: true,
        isDefault: item.isDefault,
        costoA: new Prisma.Decimal(String(item.costoA)),
        costoB: new Prisma.Decimal(String(item.costoB)),
        costoC: new Prisma.Decimal(String(item.costoC)),
      };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.brandTint.deleteMany({ where: { idBrand: brandId } });
      await tx.brandTint.createMany({ data: normalized });
    });

    return this.getBrandTintsForManage(brandId);
  }

  async getBrandCoatingsForManage(brandId: number) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, name: true },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with ID #${brandId} not found.`);
    }

    const [catalog, associations] = await Promise.all([
      this.prisma.coating.findMany({
        orderBy: [
          { isActive: "desc" },
          { globalSortOrder: "asc" },
          { name: "asc" },
          { id: "asc" },
        ],
      }),
      this.prisma.brandCoating.findMany({ where: { idBrand: brandId } }),
    ]);

    const associationById = new Map(
      associations.map((association) => [association.idCoating, association]),
    );

    const coatings = catalog.map((coating) => {
      const association = associationById.get(coating.id);

      return {
        ...coating,
        isAssociated: Boolean(association),
        sortOrder: association?.sortOrder ?? null,
        surchargeEnabled: association?.surchargeEnabled ?? false,
        isDefault: association?.isDefault ?? false,
        costoA: association?.costoA ?? null,
        costoB: association?.costoB ?? null,
        costoC: association?.costoC ?? null,
      };
    });

    coatings.sort((left, right) => {
      if (left.isAssociated !== right.isAssociated) {
        return left.isAssociated ? -1 : 1;
      }

      if (left.isAssociated && right.isAssociated) {
        const orderDifference = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
        if (orderDifference !== 0) return orderDifference;
      }

      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      return left.name.localeCompare(right.name) || left.id - right.id;
    });

    return {
      brand,
      coatings,
    };
  }

  async updateBrandCoatings(brandId: number, data: UpdateBrandCoatingsDto) {
    await this.assertBrandExists(brandId);

    if (data.coatings.length === 0) {
      throw new ConflictException(
        "A Brand must have at least one available Coating.",
      );
    }

    const coatingIds = data.coatings.map((item) => item.coatingId);
    const existingCoatings = await this.prisma.coating.findMany({
      where: { id: { in: coatingIds } },
      select: { id: true, isActive: true },
    });

    if (existingCoatings.length !== coatingIds.length) {
      const existingIds = new Set(
        existingCoatings.map((coating) => coating.id),
      );
      const missingId = coatingIds.find((id) => !existingIds.has(id));
      throw new NotFoundException(`Coating with ID #${missingId} not found.`);
    }

    const defaults = data.coatings.filter((item) => item.isDefault);

    if (defaults.length !== 1) {
      throw new ConflictException(
        "Select exactly one default Coating for this Brand.",
      );
    }

    const activeCoatingIds = new Set(
      existingCoatings
        .filter((coating) => coating.isActive)
        .map((coating) => coating.id),
    );

    if (!activeCoatingIds.has(defaults[0].coatingId)) {
      throw new ConflictException("The default Coating must be active.");
    }

    const normalized = data.coatings.map((item, index) => {
      const sortOrder = item.sortOrder ?? index;

      if (!item.surchargeEnabled) {
        return {
          idBrand: brandId,
          idCoating: item.coatingId,
          sortOrder,
          surchargeEnabled: false,
          isDefault: item.isDefault,
          costoA: null,
          costoB: null,
          costoC: null,
        };
      }

      const coefficients = [item.costoA, item.costoB, item.costoC];

      if (
        coefficients.some(
          (value) =>
            value == null ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0,
        )
      ) {
        throw new ConflictException(
          "Coating surcharge Area Cost, Perimeter Cost and Fixed Cost are required and must be zero or greater.",
        );
      }

      return {
        idBrand: brandId,
        idCoating: item.coatingId,
        sortOrder,
        surchargeEnabled: true,
        isDefault: item.isDefault,
        costoA: new Prisma.Decimal(String(item.costoA)),
        costoB: new Prisma.Decimal(String(item.costoB)),
        costoC: new Prisma.Decimal(String(item.costoC)),
      };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.brandCoating.deleteMany({ where: { idBrand: brandId } });
      await tx.brandCoating.createMany({ data: normalized });
    });

    return this.getBrandCoatingsForManage(brandId);
  }

  async getBrandPrivaciesForManage(brandId: number) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, name: true },
    });

    if (!brand) {
      throw new NotFoundException(`Brand with ID #${brandId} not found.`);
    }

    const [catalog, associations] = await Promise.all([
      this.prisma.privacy.findMany({
        orderBy: [
          { isActive: "desc" },
          { name: "asc" },
          { id: "asc" },
        ],
      }),
      this.prisma.brandPrivacy.findMany({ where: { idBrand: brandId } }),
    ]);

    const associationById = new Map(
      associations.map((association) => [association.idPrivacy, association]),
    );

    const privacies = catalog.map((privacy) => {
      const association = associationById.get(privacy.id);

      return {
        ...privacy,
        isAssociated: Boolean(association),
        sortOrder: association?.sortOrder ?? null,
        surchargeEnabled: association?.surchargeEnabled ?? false,
        isDefault: association?.isDefault ?? false,
        costoA: association?.costoA ?? null,
        costoB: association?.costoB ?? null,
        costoC: association?.costoC ?? null,
      };
    });

    privacies.sort((left, right) => {
      if (left.isAssociated !== right.isAssociated) {
        return left.isAssociated ? -1 : 1;
      }

      if (left.isAssociated && right.isAssociated) {
        const orderDifference = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
        if (orderDifference !== 0) return orderDifference;
      }

      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      return left.name.localeCompare(right.name) || left.id - right.id;
    });

    return {
      brand,
      privacies,
    };
  }

  async updateBrandPrivacies(brandId: number, data: UpdateBrandPrivaciesDto) {
    await this.assertBrandExists(brandId);

    if (data.privacies.length === 0) {
      throw new ConflictException(
        "A Brand must have at least one available Privacy option.",
      );
    }

    const privacyIds = data.privacies.map((item) => item.privacyId);
    const existingPrivacies = await this.prisma.privacy.findMany({
      where: { id: { in: privacyIds } },
      select: { id: true, isActive: true },
    });

    if (existingPrivacies.length !== privacyIds.length) {
      const existingIds = new Set(
        existingPrivacies.map((privacy) => privacy.id),
      );
      const missingId = privacyIds.find((id) => !existingIds.has(id));
      throw new NotFoundException(
        `Privacy option with ID #${missingId} not found.`,
      );
    }

    const defaults = data.privacies.filter((item) => item.isDefault);

    if (defaults.length !== 1) {
      throw new ConflictException(
        "Select exactly one default Privacy option for this Brand.",
      );
    }

    const activePrivacyIds = new Set(
      existingPrivacies
        .filter((privacy) => privacy.isActive)
        .map((privacy) => privacy.id),
    );

    if (!activePrivacyIds.has(defaults[0].privacyId)) {
      throw new ConflictException(
        "The default Privacy option must be active.",
      );
    }

    const normalized = data.privacies.map((item, index) => {
      const sortOrder = item.sortOrder ?? index;

      if (!item.surchargeEnabled) {
        return {
          idBrand: brandId,
          idPrivacy: item.privacyId,
          sortOrder,
          surchargeEnabled: false,
          isDefault: item.isDefault,
          costoA: null,
          costoB: null,
          costoC: null,
        };
      }

      const coefficients = [item.costoA, item.costoB, item.costoC];

      if (
        coefficients.some(
          (value) =>
            value == null ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0,
        )
      ) {
        throw new ConflictException(
          "Privacy surcharge Area Cost, Perimeter Cost and Fixed Cost are required and must be zero or greater.",
        );
      }

      return {
        idBrand: brandId,
        idPrivacy: item.privacyId,
        sortOrder,
        surchargeEnabled: true,
        isDefault: item.isDefault,
        costoA: new Prisma.Decimal(String(item.costoA)),
        costoB: new Prisma.Decimal(String(item.costoB)),
        costoC: new Prisma.Decimal(String(item.costoC)),
      };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.brandPrivacy.deleteMany({ where: { idBrand: brandId } });
      await tx.brandPrivacy.createMany({ data: normalized });
    });

    return this.getBrandPrivaciesForManage(brandId);
  }

  async brand(where: Prisma.BrandWhereUniqueInput): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({ where });

    if (!brand) {
      throw new NotFoundException(
        `Brand with ID #${(where as any)?.id} not found.`,
      );
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
        throw new NotFoundException(
          `Brand with ID #${(where as any)?.id} not found.`,
        );
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
        throw new NotFoundException(
          `Brand with ID #${(where as any)?.id} not found.`,
        );
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This brand is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }

  async getBrandWithProducts(
    where: Prisma.BrandWhereUniqueInput,
  ): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where,
      include: {
        brandProducts: {
          include: { product: true },
          orderBy: [
            { product: { sortOrder: "asc" } },
            { product: { name: "asc" } },
            { idProduct: "asc" },
          ],
        },
      },
    });

    if (!brand) {
      throw new NotFoundException(
        `Brand with ID #${(where as any)?.id} not found.`,
      );
    }

    return brand;
  }

  async findAllWithProducts(opts?: {
    take?: number;
    skip?: number;
  }): Promise<Brand[]> {
    const take = clampInt(opts?.take, 50, 1, 100);
    const skip = clampInt(opts?.skip, 0, 0, 10_000);

    return this.prisma.brand.findMany({
      take,
      skip,
      orderBy: { name: "asc" },
      include: {
        brandProducts: {
          include: { product: true },
          orderBy: [
            { product: { sortOrder: "asc" } },
            { product: { name: "asc" } },
            { idProduct: "asc" },
          ],
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
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
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
            orderBy: [
              { product: { sortOrder: "asc" } },
              { product: { name: "asc" } },
              { idProduct: "asc" },
            ],
          },
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException(
          "This product is already linked to the brand.",
        );
      }

      throw e;
    }
  }

  async removeProductFromBrand(
    brandId: number,
    productId: number,
  ): Promise<Brand> {
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
            orderBy: [
              { product: { sortOrder: "asc" } },
              { product: { name: "asc" } },
              { idProduct: "asc" },
            ],
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

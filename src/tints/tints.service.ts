import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, Tint } from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";
import { CreateTintDto } from "./dto/create-tint.dto";

@Injectable()
export class TintService {
  constructor(private prisma: PrismaService) {}

  async tint(where: Prisma.TintWhereUniqueInput): Promise<Tint> {
    const tint = await this.prisma.tint.findUnique({ where });

    if (!tint) {
      throw new NotFoundException(`Tint with ID #${where.id} not found.`);
    }

    return tint;
  }

  async tints(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.TintWhereUniqueInput;
    where?: Prisma.TintWhereInput;
    orderBy?: Prisma.TintOrderByWithRelationInput;
  }): Promise<Tint[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.tint.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? [
        { globalSortOrder: "asc" },
        { color: "asc" },
        { id: "asc" },
      ],
      include: {
        brandTints: {
          select: {
            idBrand: true,
            sortOrder: true,
            surchargeEnabled: true,
            isDefault: true,
          },
        },
      },
    });
  }

  async createTint(data: CreateTintDto): Promise<Tint> {
    const currentMaxOrder = await this.prisma.tint.aggregate({
      _max: { globalSortOrder: true },
    });
    const globalSortOrder =
      data.globalSortOrder ?? (currentMaxOrder._max.globalSortOrder ?? -1) + 1;

    return this.prisma.tint.create({
      data: {
        color: data.color,
        hexCode: data.hexCode,
        isGlobal: data.isGlobal,
        globalSortOrder,
      },
    });
  }

  async updateTint(params: {
    where: Prisma.TintWhereUniqueInput;
    data: Prisma.TintUpdateInput;
  }): Promise<Tint> {
    const { where, data } = params;

    try {
      if (data.isActive === false) {
        const defaultAssociation = await this.prisma.brandTint.findFirst({
          where: {
            idTint: where.id,
            isDefault: true,
          },
          select: { idBrand: true },
        });

        if (defaultAssociation) {
          throw new ConflictException(
            "This Tint is a Brand default. Select another default before deactivating it.",
          );
        }
      }

      return await this.prisma.tint.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Tint with ID #${where.id} not found.`);
      }

      throw e;
    }
  }

  async deleteTint(where: Prisma.TintWhereUniqueInput): Promise<Tint> {
    try {
      return await this.prisma.tint.delete({ where });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Tint with ID #${where.id} not found.`);
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This tint is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }
}

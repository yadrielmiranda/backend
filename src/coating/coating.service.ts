import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Coating } from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";

@Injectable()
export class CoatingService {
  constructor(private prisma: PrismaService) {}

  async coating(where: Prisma.CoatingWhereUniqueInput): Promise<Coating> {
    const coating = await this.prisma.coating.findUnique({ where });

    if (!coating) {
      throw new NotFoundException(`Coating with ID #${where.id} not found.`);
    }

    return coating;
  }

  async coatings(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.CoatingWhereUniqueInput;
    where?: Prisma.CoatingWhereInput;
    orderBy?: Prisma.CoatingOrderByWithRelationInput;
  }): Promise<Coating[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.coating.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy: orderBy ?? { name: "asc" },
    });
  }

  async createCoating(data: Prisma.CoatingCreateInput): Promise<Coating> {
    return this.prisma.coating.create({ data });
  }

  async updateCoating(params: {
    where: Prisma.CoatingWhereUniqueInput;
    data: Prisma.CoatingUpdateInput;
  }): Promise<Coating> {
    const { where, data } = params;

    try {
      return await this.prisma.coating.update({ where, data });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Coating with ID #${where.id} not found.`);
      }

      throw e;
    }
  }

  async deleteCoating(where: Prisma.CoatingWhereUniqueInput): Promise<Coating> {
    try {
      return await this.prisma.coating.delete({ where });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(`Coating with ID #${where.id} not found.`);
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This coating is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }
}
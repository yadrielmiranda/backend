import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { FrameColor, Prisma } from "@prisma/client";
import { CreateFrameColorDto } from "./dto/create-frame-color.dto";

@Injectable()
export class FrameColorService {
  constructor(private prisma: PrismaService) {}

  async color(where: Prisma.FrameColorWhereUniqueInput): Promise<FrameColor> {
    const color = await this.prisma.frameColor.findUnique({ where });

    if (!color) {
      throw new NotFoundException(`FrameColor with ID #${where.id} not found.`);
    }

    return color;
  }

  async colors(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.FrameColorWhereUniqueInput;
    where?: Prisma.FrameColorWhereInput;
    orderBy?: Prisma.FrameColorOrderByWithRelationInput;
  }): Promise<FrameColor[]> {
    return this.prisma.frameColor.findMany({
      ...params,
      orderBy: params.orderBy ?? [
        { globalSortOrder: "asc" },
        { color: "asc" },
        { id: "asc" },
      ],
    });
  }

  async getGlobalDefaults() {
    return this.prisma.frameColor.findMany({
      where: {
        isActive: true,
        isGlobal: true,
      },
      orderBy: [{ globalSortOrder: "asc" }, { color: "asc" }, { id: "asc" }],
    });
  }

  async createColor(data: CreateFrameColorDto): Promise<FrameColor> {
    const currentMaxOrder = await this.prisma.frameColor.aggregate({
      _max: { globalSortOrder: true },
    });
    const globalSortOrder =
      data.globalSortOrder ?? (currentMaxOrder._max.globalSortOrder ?? -1) + 1;

    return this.prisma.frameColor.create({
      data: {
        color: data.color,
        hexCode: data.hexCode,
        isGlobal: data.isGlobal,
        globalSortOrder,
      },
    });
  }

  async updateColor(params: {
    where: Prisma.FrameColorWhereUniqueInput;
    data: Prisma.FrameColorUpdateInput;
  }): Promise<FrameColor> {
    const { where, data } = params;

    try {
      return await this.prisma.frameColor.update({
        where,
        data,
      });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(
          `FrameColor with ID #${where.id} not found.`,
        );
      }

      throw e;
    }
  }

  async deleteColor(
    where: Prisma.FrameColorWhereUniqueInput,
  ): Promise<FrameColor> {
    try {
      return await this.prisma.frameColor.delete({ where });
    } catch (e: any) {
      if (e?.code === "P2025") {
        throw new NotFoundException(
          `FrameColor with ID #${where.id} not found.`,
        );
      }

      if (e?.code === "P2003") {
        throw new ConflictException(
          "This frame color is being used and cannot be deleted. Deactivate it instead.",
        );
      }

      throw e;
    }
  }
}

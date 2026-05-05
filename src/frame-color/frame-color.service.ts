import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { FrameColor, Prisma } from '@prisma/client';

@Injectable()
export class FrameColorService {
  constructor(private prisma: PrismaService) { }

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
      orderBy: params.orderBy ?? { color: 'asc' },
    });
  }


  async getGlobalDefaults() {
    return this.prisma.frameColor.findMany({
      where: {
        isActive: true,
        isGlobal: true,
      },
      orderBy: { color: 'asc' },
    });
  }

  async createColor(data: Prisma.FrameColorCreateInput): Promise<FrameColor> {
    return this.prisma.frameColor.create({
      data,
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
      if (e?.code === 'P2025') {
        throw new NotFoundException(`FrameColor with ID #${where.id} not found.`);
      }

      throw e;
    }
  }

  async deleteColor(where: Prisma.FrameColorWhereUniqueInput): Promise<FrameColor> {
    try {
      return await this.prisma.frameColor.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`FrameColor with ID #${where.id} not found.`);
      }

      if (e?.code === 'P2003') {
        throw new ConflictException(
          'This frame color is being used and cannot be deleted. Deactivate it instead.',
        );
      }

      throw e;
    }
  }
}
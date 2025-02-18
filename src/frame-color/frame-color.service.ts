import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FrameColor, Prisma, } from '@prisma/client';

@Injectable()
export class FrameColorService {

  constructor(private prisma: PrismaService) { }


  async color(
    frameColorWhereUniqueInput: Prisma.FrameColorWhereUniqueInput
  ): Promise<FrameColor | null> {
    return this.prisma.frameColor.findUnique({
      where: frameColorWhereUniqueInput,
    });
  }

  async colors(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.FrameColorWhereUniqueInput;
    where?: Prisma.FrameColorWhereInput;
    orderBy?: Prisma.FrameColorOrderByWithRelationInput;
  }): Promise<FrameColor[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.frameColor.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
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
    return this.prisma.frameColor.update({
      data,
      where
    });
  }

  async deleteColor(where: Prisma.FrameColorWhereUniqueInput): Promise<FrameColor> {
    return this.prisma.frameColor.delete({
      where,
    });
  }
}

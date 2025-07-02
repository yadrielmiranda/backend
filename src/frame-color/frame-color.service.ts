import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FrameColor, Prisma, } from '@prisma/client';

@Injectable()
export class FrameColorService {

  constructor(private prisma: PrismaService) { }


  async color(
    frameColorWhereUniqueInput: Prisma.FrameColorWhereUniqueInput,
  ): Promise<FrameColor> {
    const color = await this.prisma.frameColor.findUnique({
      where: frameColorWhereUniqueInput,
    });

    //  Si no se encuentra el color, lanza un error 404.
    if (!color) {
      throw new NotFoundException(
        `FrameColor with ID #${frameColorWhereUniqueInput.id} not found`,
      );
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
    
    //  Verifica que el color exista antes de intentar actualizarlo.
    try {
      return await this.prisma.frameColor.update({
        data,
        where,
      });
    } catch (error) {
      // Prisma lanza un error si el registro a actualizar no existe.
      throw new NotFoundException(`FrameColor with ID #${where.id} not found`);
    }
  }

   async deleteColor(where: Prisma.FrameColorWhereUniqueInput): Promise<FrameColor> {
    // Verifica que el color exista antes de intentar borrarlo.
    try {
      return await this.prisma.frameColor.delete({
        where,
      });
    } catch (error) {
      // Prisma lanza un error si el registro a borrar no existe.
      throw new NotFoundException(`FrameColor with ID #${where.id} not found`);
    }
  }
}

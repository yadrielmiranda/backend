import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Coating } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CoatingService {
  constructor(private prisma: PrismaService) { }

  async coating(
    coatingWhereUniqueInput: Prisma.CoatingWhereUniqueInput
  ): Promise<Coating> {
    const coating = await this.prisma.coating.findUnique({
      where: coatingWhereUniqueInput,
    });

    // Si no se encuentra el coating, lanza un error 404.
    if (!coating) {
      throw new NotFoundException(
        `Coating with ID #${coatingWhereUniqueInput.id} not found`,
      );
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
      orderBy,
    });
  }

  async createCoating(data: Prisma.CoatingCreateInput): Promise<Coating> {
    return this.prisma.coating.create({
      data,
    });
  }

  async updateCoating(params: {
    where: Prisma.CoatingWhereUniqueInput;
    data: Prisma.CoatingUpdateInput;
  }): Promise<Coating> {
    const { where, data } = params;

    // Verifica que el coating exista antes de intentar actualizarlo.
    try {
      return await this.prisma.coating.update({
        data,
        where,
      });
    } catch (error) {
      // Prisma lanza un error si el registro a actualizar no existe.
      throw new NotFoundException(`Coating with ID #${where.id} not found`);
    }
  }

  async deleteCoating(where: Prisma.CoatingWhereUniqueInput): Promise<Coating> {
    // Verifica que el coating exista antes de intentar borrarlo.
    try {
      return await this.prisma.coating.delete({
        where,
      });
    } catch (error) {
      // Prisma lanza un error si el registro a borrar no existe.
      throw new NotFoundException(`Coating with ID #${where.id} not found`);
    }
  }
}
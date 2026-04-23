import { Injectable, NotFoundException } from '@nestjs/common';
import { MuntinPattern, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateMuntinPatternDto } from './dto/create-muntin-pattern.dto';
import { UpdateMuntinPatternDto } from './dto/update-muntin-pattern.dto';

@Injectable()
export class MuntinPatternsService {
  constructor(private prisma: PrismaService) {}

  async muntinPattern(
    where: Prisma.MuntinPatternWhereUniqueInput,
  ): Promise<MuntinPattern> {
    const pattern = await this.prisma.muntinPattern.findUnique({ where });

    if (!pattern) {
      throw new NotFoundException(
        `MuntinPattern with ID #${where.id} not found.`,
      );
    }

    return pattern;
  }

  async muntinPatterns(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.MuntinPatternWhereUniqueInput;
    where?: Prisma.MuntinPatternWhereInput;
    orderBy?: Prisma.MuntinPatternOrderByWithRelationInput;
  }): Promise<MuntinPattern[]> {
    const { skip, take, cursor, where, orderBy } = params;

    return this.prisma.muntinPattern.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createMuntinPattern(
    data: CreateMuntinPatternDto,
  ): Promise<MuntinPattern> {
    return this.prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.muntinPattern.updateMany({
          data: { isDefault: false },
        });
      }

      return tx.muntinPattern.create({
        data: {
          name: data.name.trim(),
          requiresLites: data.requiresLites ?? true,
          isActive: data.isActive ?? true,
          isDefault: data.isDefault ?? false,
        },
      });
    });
  }

  async updateMuntinPattern(params: {
    where: Prisma.MuntinPatternWhereUniqueInput;
    data: UpdateMuntinPatternDto;
  }): Promise<MuntinPattern> {
    const { where, data } = params;

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (data.isDefault === true) {
          await tx.muntinPattern.updateMany({
            where: { NOT: { id: where.id } },
            data: { isDefault: false },
          });
        }

        return tx.muntinPattern.update({
          where,
          data: {
            ...(data.name !== undefined ? { name: data.name.trim() } : {}),
            ...(data.requiresLites !== undefined
              ? { requiresLites: data.requiresLites }
              : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            ...(data.isDefault !== undefined
              ? { isDefault: data.isDefault }
              : {}),
          },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `MuntinPattern with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }

  async deleteMuntinPattern(
    where: Prisma.MuntinPatternWhereUniqueInput,
  ): Promise<MuntinPattern> {
    try {
      return await this.prisma.muntinPattern.delete({ where });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `MuntinPattern with ID #${where.id} not found.`,
        );
      }
      throw e;
    }
  }
}
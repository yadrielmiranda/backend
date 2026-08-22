import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { GlobalParameter, GlobalParameterKey, Prisma } from '@prisma/client';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';

@Injectable()
export class GlobalParametersService {
  constructor(private prisma: PrismaService) {}

  async findAll(): Promise<GlobalParameter[]> {
    return this.prisma.globalParameter.findMany({ orderBy: { key: 'asc' } });
  }

  async update(key: GlobalParameterKey, dto: UpdateGlobalParameterDto): Promise<GlobalParameter> {
    const exists = await this.prisma.globalParameter.findUnique({
      where: { key },
      select: { key: true },
    });

    if (!exists) {
      throw new NotFoundException(`Parameter with key "${key}" not found.`);
    }

    let dec: Prisma.Decimal;
    try {
      dec = new Prisma.Decimal(dto.value);
    } catch {
      throw new BadRequestException('Invalid numeric value.');
    }

    if (
      key === GlobalParameterKey.DELIVERY_BASE_PRICE &&
      dec.lte(0)
    ) {
      throw new BadRequestException(
        'Delivery base price must be greater than zero.',
      );
    }
    if (
      (key === GlobalParameterKey.DELIVERY_INCLUDED_MILES ||
        key === GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE) &&
      dec.lt(0)
    ) {
      throw new BadRequestException(
        'Delivery miles and additional-mile price cannot be negative.',
      );
    }

    try {
      return await this.prisma.globalParameter.update({
        where: { key },
        data: {
          description: dto.description,
          unit: dto.unit,
          value: dec,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Parameter with key "${key}" not found.`);
      }
      throw e;
    }
  }
}

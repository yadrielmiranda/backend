import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { GlobalParameter, GlobalParameterKey, Prisma } from '@prisma/client';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';
import { DELIVERY_PARAMETER_KEYS } from '@/warehouse-delivery/warehouse-delivery.constants';

@Injectable()
export class GlobalParametersService {
  constructor(private prisma: PrismaService) {}

  async findAll(includeInternal = false): Promise<GlobalParameter[]> {
    return this.prisma.globalParameter.findMany({
      ...(includeInternal ? {} : {
        where: { key: { not: GlobalParameterKey.MATERIAL_ONLY_UPFRONT_THRESHOLD } },
      }),
      orderBy: { key: 'asc' },
    });
  }

  async update(key: GlobalParameterKey, dto: UpdateGlobalParameterDto): Promise<GlobalParameter> {
    if (DELIVERY_PARAMETER_KEYS.includes(key)) {
      throw new BadRequestException('Manage delivery pricing in Settings > Warehouse & Delivery.');
    }
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

    const isMaterialOnlyThreshold =
      key === GlobalParameterKey.MATERIAL_ONLY_UPFRONT_THRESHOLD;
    if (isMaterialOnlyThreshold) {
      if (
        !/^\d+(?:\.\d{1,2})?$/.test(dto.value) ||
        !dec.isFinite() || dec.lt(0) || dec.gt('999999.99') ||
        dec.decimalPlaces() > 2
      ) {
        throw new BadRequestException(
          'Enter a USD amount from 0 to 999,999.99 with at most two decimal places. Zero disables the material-only full payment rule.',
        );
      }
      if (dto.unit !== undefined && dto.unit !== 'USD') {
        throw new BadRequestException('The material-only full payment threshold must use USD.');
      }
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
          unit: isMaterialOnlyThreshold ? 'USD' : dto.unit,
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

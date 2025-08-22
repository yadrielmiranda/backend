import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { GlobalParameter, GlobalParameterKey } from '@prisma/client';
import { UpdateGlobalParameterDto } from './dto/update-global-parameter.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class GlobalParametersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Fetches all global parameters from the database.
   * @returns A promise that resolves to an array of GlobalParameter.
   */
  async findAll(): Promise<GlobalParameter[]> {
    return this.prisma.globalParameter.findMany({
      orderBy: { key: 'asc' },
    });
  }

  /**
   * Updates a global parameter identified by its key.
   * @param key The unique key of the parameter to update.
   * @param dto The data to update the parameter with.
   * @returns A promise that resolves to the updated GlobalParameter.
   */
  async update(
    key: GlobalParameterKey,
    dto: UpdateGlobalParameterDto,
  ): Promise<GlobalParameter> {
    const parameter = await this.prisma.globalParameter.findUnique({
      where: { key },
    });

    if (!parameter) {
      throw new NotFoundException(`Parameter with key "${key}" not found.`);
    }

    // Convert the string value from DTO to Prisma.Decimal for the database
    const dataToUpdate: Prisma.GlobalParameterUpdateInput = {
      ...dto,
      value: new Prisma.Decimal(dto.value),
    };

    return this.prisma.globalParameter.update({
      where: { key },
      data: dataToUpdate,
    });
  }
}

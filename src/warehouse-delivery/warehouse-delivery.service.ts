import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { GlobalParameterKey, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { SaveWarehouseDeliveryDto } from './dto/save-warehouse-delivery.dto';
import { DELIVERY_PARAMETER_KEYS } from './warehouse-delivery.constants';

const conflictMessage =
  'Warehouse & Delivery settings changed. Reload the page before saving again.';

@Injectable()
export class WarehouseDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  private async read(tx: Prisma.TransactionClient) {
    const configuration = await tx.warehouseDeliverySettings.findUnique({
      where: { id: 1 },
    });
    const parameters = await tx.globalParameter.findMany({
      where: { key: { in: DELIVERY_PARAMETER_KEYS } },
    });
    const values = new Map(
      parameters.map((parameter) => [
        parameter.key,
        parameter.value.toString(),
      ]),
    );
    return {
      configuration,
      pricing: {
        basePrice: values.get(GlobalParameterKey.DELIVERY_BASE_PRICE) ?? null,
        includedMiles:
          values.get(GlobalParameterKey.DELIVERY_INCLUDED_MILES) ?? null,
        additionalMilePrice:
          values.get(GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE) ?? null,
      },
    };
  }

  find() {
    // Dirección y tarifas se leen desde la misma versión de la configuración.
    return this.prisma.$transaction((tx) => this.read(tx));
  }

  pickupAddress() {
    // Los clientes solo necesitan el punto de recogida.
    return this.prisma.warehouseDeliverySettings.findUnique({
      where: { id: 1 },
      select: { street: true, city: true, state: true, postalCode: true },
    });
  }

  async save(dto: SaveWarehouseDeliveryDto, actorId: number) {
    if (new Decimal(dto.includedMiles).gt(dto.maxDeliveryMiles)) {
      throw new BadRequestException(
        'Included miles cannot exceed the maximum delivery distance.',
      );
    }
    const data = {
      street: dto.street,
      city: dto.city,
      state: dto.state,
      postalCode: dto.postalCode,
      maxDeliveryMiles: new Prisma.Decimal(dto.maxDeliveryMiles),
    };
    const parameters = [
      {
        key: GlobalParameterKey.DELIVERY_BASE_PRICE,
        value: dto.basePrice,
        unit: 'USD',
        description: 'Base delivery price through the included-mile threshold.',
      },
      {
        key: GlobalParameterKey.DELIVERY_INCLUDED_MILES,
        value: dto.includedMiles,
        unit: 'miles',
        description: 'One-way road miles included in the base delivery price.',
      },
      {
        key: GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE,
        value: dto.additionalMilePrice,
        unit: 'USD/mile',
        description:
          'Price per additional one-way road mile, including fractional miles.',
      },
    ];
    try {
      return await this.prisma.$transaction(async (tx) => {
        // La revisión evita que otro administrador sobrescriba dirección o tarifas.
        if (dto.revision === 0) {
          await tx.warehouseDeliverySettings.create({
            data: { id: 1, revision: 1, ...data },
          });
        } else {
          const result = await tx.warehouseDeliverySettings.updateMany({
            where: { id: 1, revision: dto.revision },
            data: { ...data, revision: { increment: 1 } },
          });
          if (result.count !== 1) throw new ConflictException(conflictMessage);
        }
        for (const parameter of parameters) {
          const value = new Prisma.Decimal(parameter.value);
          await tx.globalParameter.upsert({
            where: { key: parameter.key },
            create: { ...parameter, value },
            update: {
              value,
              description: parameter.description,
              unit: parameter.unit,
            },
          });
        }
        await tx.eventLog.create({
          data: {
            action: dto.revision === 0 ? 'CREATE' : 'UPDATE',
            entityType: 'WarehouseDeliverySettings',
            entityId: 1,
            userId: actorId,
            message: 'Warehouse & Delivery settings saved.',
          },
        });
        return this.read(tx);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(conflictMessage);
      }
      throw error;
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { SaveInstallationCoverageDto } from './dto/installation-coverage.dto';

const conflictMessage =
  'Installation coverage changed. Reload the page before saving again.';

@Injectable()
export class InstallationCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  find() {
    return this.prisma.installationCoverage.findUnique({ where: { id: 1 } });
  }

  async save(dto: SaveInstallationCoverageDto, actorId: number) {
    const maximum = new Decimal(dto.maxDistanceMiles);
    const included = new Decimal(dto.includedMiles);
    if (included.gt(maximum)) {
      throw new BadRequestException(
        'Included miles cannot exceed the maximum distance.',
      );
    }

    // Cada límite inferior se deriva del anterior: no hay huecos ni solapamientos.
    let lower = included;
    const ranges = dto.ranges.map((range, index) => {
      const upper = new Decimal(range.upToMiles);
      if (upper.lte(lower) || upper.gt(maximum)) {
        throw new BadRequestException(
          `Range ${index + 1} must end after the previous range and within the maximum distance.`,
        );
      }
      const result = {
        fromMiles: lower.toFixed(2),
        upToMiles: upper.toFixed(2),
        chargeType: range.chargeType,
        value: new Decimal(range.value).toFixed(2),
      };
      lower = upper;
      return result;
    });
    if (!lower.eq(maximum)) {
      throw new BadRequestException(
        'The ranges must cover the entire distance after the included miles, up to the maximum distance.',
      );
    }

    const data = {
      originStreet: dto.originStreet,
      originCity: dto.originCity,
      originState: dto.originState,
      originPostalCode: dto.originPostalCode,
      maxDistanceMiles: new Prisma.Decimal(maximum.toFixed(2)),
      includedMiles: new Prisma.Decimal(included.toFixed(2)),
      ranges,
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // La revisión evita sobrescribir la edición de otro administrador.
        if (dto.revision === 0) {
          await tx.installationCoverage.create({
            data: { id: 1, revision: 1, ...data },
          });
        } else {
          const result = await tx.installationCoverage.updateMany({
            where: { id: 1, revision: dto.revision },
            data: { ...data, revision: { increment: 1 } },
          });
          if (result.count !== 1) throw new ConflictException(conflictMessage);
        }
        await tx.eventLog.create({
          data: {
            action: dto.revision === 0 ? 'CREATE' : 'UPDATE',
            entityType: 'InstallationCoverage',
            entityId: 1,
            userId: actorId,
            message: 'Installation coverage settings saved.',
          },
        });
        return tx.installationCoverage.findUniqueOrThrow({ where: { id: 1 } });
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

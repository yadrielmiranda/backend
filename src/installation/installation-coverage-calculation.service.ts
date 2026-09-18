import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { GoogleAddressValidationService } from '@/deliveries/google-address-validation.service';
import { GoogleRoutesService } from '@/deliveries/google-routes.service';
import {
  installationAddress,
  type InstallationAddress,
} from './installation-address';

const unavailable =
  'Installation pricing is temporarily unavailable. Please try again or contact support.';

export type InstallationSurchargeCalculation = {
  totalMinutes: string;
  installationDays: string;
  oneTimeCharge: string;
  dailyChargeTotal: string;
  totalCharge: string;
};

export type CoverageSnapshot = {
  schema: 1 | 2;
  revision: number;
  origin: InstallationAddress;
  destination: InstallationAddress & { placeId: string };
  distanceMeters: number;
  maximumMiles: string;
  includedMiles: string;
  hoursPerDay?: string;
  range: {
    type: 'NONE' | 'FIXED' | 'PERCENTAGE';
    value: string;
    fromMiles: string;
    upToMiles: string;
    dailyCharge?: string;
  };
  calculation?: InstallationSurchargeCalculation;
};

function savedDecimal(value: string | undefined): Decimal {
  try {
    const number = new Decimal(value!);
    if (number.isFinite() && number.gte(0)) return number;
  } catch {
    // Los detalles privados de configuración no se reenvían al usuario.
  }
  throw new ServiceUnavailableException(unavailable);
}

// Ambos cargos proceden exclusivamente del tramo guardado con la cotización.
export function installationSurchargeCalculation(
  base: Decimal,
  snapshot: CoverageSnapshot,
  totalMinutes = new Decimal(0),
): InstallationSurchargeCalculation {
  const { type, value } = snapshot.range;
  if (
    ![1, 2].includes(snapshot.schema) ||
    !['NONE', 'FIXED', 'PERCENTAGE'].includes(type) ||
    !totalMinutes.isFinite() || totalMinutes.lt(0)
  ) {
    throw new ServiceUnavailableException(unavailable);
  }
  const amount = savedDecimal(value);
  const oneTimeCharge = (
    type === 'NONE'
      ? new Decimal(0)
      : type === 'FIXED'
        ? amount
        : base.mul(amount).div(100)
  ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  let days = new Decimal(0);
  let dailyChargeTotal = new Decimal(0);
  // Las cotizaciones anteriores conservan solo el cargo que tenían acordado.
  if (snapshot.schema === 2) {
    const hoursPerDay = savedDecimal(snapshot.hoursPerDay);
    if (hoursPerDay.lte(0) || hoursPerDay.gt(24)) {
      throw new ServiceUnavailableException(unavailable);
    }
    // Se redondea una sola vez tras sumar todos los servicios. Cero minutos son cero días.
    days = totalMinutes.div(hoursPerDay.mul(60)).ceil();
    if (type !== 'NONE') {
      dailyChargeTotal = savedDecimal(snapshot.range.dailyCharge).mul(days)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  }
  const surcharge = oneTimeCharge.add(dailyChargeTotal);
  if (base.add(surcharge).gt('9999999999.99'))
    throw new BadRequestException(
      'The installation amount exceeds the supported limit. Please contact support.',
    );
  return {
    totalMinutes: totalMinutes.toString(),
    installationDays: days.toFixed(0),
    oneTimeCharge: oneTimeCharge.toFixed(2),
    dailyChargeTotal: dailyChargeTotal.toFixed(2),
    totalCharge: surcharge.toFixed(2),
  };
}

export function installationSurcharge(
  base: Decimal,
  snapshot: CoverageSnapshot,
  totalMinutes = new Decimal(0),
): Decimal {
  return new Decimal(installationSurchargeCalculation(base, snapshot, totalMinutes).totalCharge);
}

// Los adicionales y sus mínimos exclusivos no forman parte de la base del recargo.
export function installationBaseForSurcharge(
  total: Decimal,
  lines: Array<{
    serviceId: number;
    origin: string;
    adjustedAmount: { toString(): string };
  }>,
  minimums: Array<{ serviceId: number; adjustment: string }>,
): Decimal {
  const automatic = new Set(
    lines
      .filter((line) => line.origin === 'AUTO')
      .map((line) => line.serviceId),
  );
  const extraLines = lines.filter((line) =>
    ['USER_SELECTED', 'FIELD_ADDED'].includes(line.origin),
  );
  const extras = new Set(extraLines.map((line) => line.serviceId));
  const extraAmount = extraLines.reduce(
    (sum, line) => sum.add(line.adjustedAmount.toString()),
    new Decimal(0),
  );
  const extraMinimums = minimums
    .filter(
      (item) => extras.has(item.serviceId) && !automatic.has(item.serviceId),
    )
    .reduce((sum, item) => sum.add(item.adjustment), new Decimal(0));
  return Decimal.max(0, total.minus(extraAmount).minus(extraMinimums));
}

@Injectable()
export class InstallationCoverageCalculationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: GoogleAddressValidationService,
    private readonly routes: GoogleRoutesService,
  ) {}

  async prepare(input: InstallationAddress) {
    const address = installationAddress(input);
    if (!address)
      throw new BadRequestException(
        'Confirm a complete installation address before calculating the price.',
      );
    // Se rechaza antes de consultar a Google, incluso si se invoca el servicio directamente.
    address.state = address.state.toUpperCase();
    if (address.state !== 'FL') {
      throw new BadRequestException('Installation is available only in Florida.');
    }
    const policy = await this.prisma.installationCoverage.findUnique({
      where: { id: 1 },
    });
    if (!policy) throw new ServiceUnavailableException(unavailable);
    let destination: Awaited<
      ReturnType<GoogleAddressValidationService['validateDeliveryAddress']>
    >;
    try {
      destination = await this.addresses.validateDeliveryAddress(address);
    } catch (error) {
      if (error instanceof BadRequestException)
        throw new BadRequestException(
          'We could not verify this installation address. Check the street, city, state and ZIP code.',
        );
      throw new ServiceUnavailableException(
        'Installation address verification is temporarily unavailable. Please try again.',
      );
    }
    const origin = {
      street: policy.originStreet,
      city: policy.originCity,
      state: policy.originState,
      postalCode: policy.originPostalCode,
    };
    let distanceMeters: number;
    try {
      ({ distanceMeters } = await this.routes.calculateDrivingRoute(
        origin,
        destination,
      ));
      if (!Number.isInteger(distanceMeters) || distanceMeters < 0)
        throw new Error('Invalid distance');
    } catch {
      // No reenviar errores del proveedor, rutas, origen ni configuración al usuario.
      throw new ServiceUnavailableException(unavailable);
    }
    const miles = new Decimal(distanceMeters).div('1609.344');
    if (miles.gt(policy.maxDistanceMiles.toString()))
      throw new BadRequestException(
        'Installation is not available at this address.',
      );
    const ranges = policy.ranges as Array<{
      fromMiles: string;
      upToMiles: string;
      chargeType: 'FIXED' | 'PERCENTAGE';
      value: string;
      dailyCharge?: string;
    }>;
    const range = miles.lte(policy.includedMiles.toString())
      ? {
          type: 'NONE' as const,
          value: '0.00',
          dailyCharge: '0.00',
          fromMiles: '0.00',
          upToMiles: policy.includedMiles.toString(),
        }
      : (() => {
          const matched = ranges.find(
            (r) => miles.gt(r.fromMiles) && miles.lte(r.upToMiles),
          );
          if (!matched) throw new ServiceUnavailableException(unavailable);
          return {
            type: matched.chargeType,
            value: matched.value,
            dailyCharge: matched.dailyCharge ?? '0.00',
            fromMiles: matched.fromMiles,
            upToMiles: matched.upToMiles,
          };
        })();
    const snapshot: CoverageSnapshot = {
      schema: 2,
      revision: policy.revision,
      origin,
      destination,
      distanceMeters,
      maximumMiles: policy.maxDistanceMiles.toString(),
      includedMiles: policy.includedMiles.toString(),
      hoursPerDay: policy.hoursPerDay.toString(),
      range,
    };
    return { address, snapshot };
  }

  async assertCurrent(
    snapshot: CoverageSnapshot,
    tx: Prisma.TransactionClient,
  ) {
    const current = await tx.installationCoverage.findUnique({
      where: { id: 1 },
      select: { revision: true },
    });
    if (current?.revision !== snapshot.revision)
      throw new ConflictException(
        'Installation pricing changed. Please calculate the installation again.',
      );
  }
}

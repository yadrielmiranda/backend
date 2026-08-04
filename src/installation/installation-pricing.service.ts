import { BadRequestException, Injectable } from '@nestjs/common';
import {
  InstallationBillingUnit,
  InstallationLineOrigin,
  InstallationRuleMetric,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { areaPerimeterFor } from '../pricing/shape-geometry';
import { dimsInchesToFeet } from '../pricing/units';

type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type InstallationProfileSnapshot = {
  id: number | null;
  name: string;
  adjustmentPercent: Decimal;
  minimumCharge: Decimal;
};

export type InstallationPricingDimensions = {
  widthIn?: number | string | Prisma.Decimal | null;
  heightIn?: number | string | Prisma.Decimal | null;
  areaSqFt?: number | string | Prisma.Decimal | null;
  heightLeftIn?: number | string | Prisma.Decimal | null;
  heightRightIn?: number | string | Prisma.Decimal | null;
  legHeightIn?: number | string | Prisma.Decimal | null;
  panelCount?: number | null;
  lengthIn?: number | string | Prisma.Decimal | null;
  configName?: string | null;
};

export type InstallationServiceForPricing = Prisma.InstallationServiceGetPayload<{
  include: { rules: true };
}>;

export type InstallationServiceMinimumInput = {
  serviceId: number;
  serviceName: string;
  minimumCharge: Decimal | Prisma.Decimal | string | number;
  adjustedAmount: Decimal | Prisma.Decimal | string | number;
};

export type InstallationServiceMinimumSnapshot = {
  serviceId: number;
  serviceName: string;
  minimumCharge: string;
  calculatedAmount: string;
  adjustment: string;
};

type CalculateLineInput = {
  service: InstallationServiceForPricing;
  profile: InstallationProfileSnapshot;
  origin: InstallationLineOrigin;
  dimensions: InstallationPricingDimensions;
  occurrences?: number;
  measurementId?: number | null;
  sourceSystemId?: number | null;
  sourceConfigId?: number | null;
  componentIndex?: number | null;
  componentLabel?: string | null;
  description?: string | null;
  sortOrder?: number;
};

@Injectable()
export class InstallationPricingService {
  constructor(private readonly prisma: PrismaService) {}

  private decimalOrNull(value: unknown): Decimal | null {
    if (value === null || value === undefined || value === '') return null;
    const result = new Decimal(String(value));
    return result.isFinite() ? result : null;
  }

  private requirePositive(value: Decimal | null, label: string): Decimal {
    if (!value || value.lte(0)) {
      throw new BadRequestException(`${label} must be greater than zero.`);
    }
    return value;
  }

  calculateServiceMinimums(lines: InstallationServiceMinimumInput[]) {
    const grouped = new Map<
      number,
      {
        serviceName: string;
        minimumCharge: Decimal;
        calculatedAmount: Decimal;
      }
    >();

    for (const line of lines) {
      const minimumCharge = new Decimal(String(line.minimumCharge));
      const adjustedAmount = new Decimal(String(line.adjustedAmount));
      if (!minimumCharge.isFinite() || minimumCharge.lt(0)) {
        throw new BadRequestException(
          `Minimum charge for service "${line.serviceName}" is invalid.`,
        );
      }
      if (!adjustedAmount.isFinite() || adjustedAmount.lt(0)) {
        throw new BadRequestException(
          `Calculated amount for service "${line.serviceName}" is invalid.`,
        );
      }

      const current = grouped.get(line.serviceId);
      if (current) {
        current.calculatedAmount = current.calculatedAmount.add(adjustedAmount);
        current.minimumCharge = minimumCharge;
      } else {
        grouped.set(line.serviceId, {
          serviceName: line.serviceName,
          minimumCharge,
          calculatedAmount: adjustedAmount,
        });
      }
    }

    const snapshot: InstallationServiceMinimumSnapshot[] = [];
    let totalAdjustment = new Decimal(0);

    for (const [serviceId, service] of grouped) {
      const calculatedAmount = service.calculatedAmount.toDecimalPlaces(
        2,
        Decimal.ROUND_HALF_UP,
      );
      const adjustment = Decimal.max(
        0,
        service.minimumCharge.minus(calculatedAmount),
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      totalAdjustment = totalAdjustment.add(adjustment);
      snapshot.push({
        serviceId,
        serviceName: service.serviceName,
        minimumCharge: service.minimumCharge.toFixed(2),
        calculatedAmount: calculatedAmount.toFixed(2),
        adjustment: adjustment.toFixed(2),
      });
    }

    return {
      totalAdjustment: totalAdjustment.toDecimalPlaces(
        2,
        Decimal.ROUND_HALF_UP,
      ),
      snapshot,
    };
  }

  async resolveProfileForUser(
    userId: number,
    tx: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<InstallationProfileSnapshot> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        installationPriceProfile: true,
        role: {
          select: {
            installationPriceProfile: true,
          },
        },
      },
    });

    if (!user) throw new BadRequestException(`User #${userId} not found.`);

    const selected =
      (user.installationPriceProfile?.isActive
        ? user.installationPriceProfile
        : null) ??
      (user.role.installationPriceProfile?.isActive
        ? user.role.installationPriceProfile
        : null) ??
      (await tx.installationPriceProfile.findFirst({
        where: { isDefault: true, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }));

    if (!selected) {
      return {
        id: null,
        name: 'Base',
        adjustmentPercent: new Decimal(0),
        minimumCharge: new Decimal(0),
      };
    }

    return {
      id: selected.id,
      name: selected.name,
      adjustmentPercent: new Decimal(selected.adjustmentPercent.toString()),
      minimumCharge: new Decimal(selected.minimumCharge.toString()),
    };
  }

  private matchesRule(
    value: Decimal,
    rule: InstallationServiceForPricing['rules'][number],
  ): boolean {
    if (rule.minValue != null) {
      const minimum = new Decimal(rule.minValue.toString());
      if (value.lt(minimum) || (value.eq(minimum) && !rule.minInclusive)) {
        return false;
      }
    }

    if (rule.maxValue != null) {
      const maximum = new Decimal(rule.maxValue.toString());
      if (value.gt(maximum) || (value.eq(maximum) && !rule.maxInclusive)) {
        return false;
      }
    }

    return true;
  }

  calculateLine(input: CalculateLineInput) {
    const widthIn = this.decimalOrNull(input.dimensions.widthIn);
    const heightIn = this.decimalOrNull(input.dimensions.heightIn);
    const explicitAreaSqFt = this.decimalOrNull(input.dimensions.areaSqFt);
    const heightLeftIn = this.decimalOrNull(input.dimensions.heightLeftIn);
    const heightRightIn = this.decimalOrNull(input.dimensions.heightRightIn);
    const legHeightIn = this.decimalOrNull(input.dimensions.legHeightIn);
    const lengthIn =
      this.decimalOrNull(input.dimensions.lengthIn) ?? widthIn;
    const panelCount =
      input.dimensions.panelCount == null
        ? null
        : Number(input.dimensions.panelCount);

    const configName = input.dimensions.configName?.trim() || null;
    let geometricArea = explicitAreaSqFt ?? new Decimal(0);

    if (
      !explicitAreaSqFt &&
      widthIn &&
      (heightIn || heightLeftIn || heightRightIn)
    ) {
      const dimensionsFt = dimsInchesToFeet({
        width: widthIn.toString(),
        height: heightIn?.toString(),
        heightLeft: heightLeftIn?.toString(),
        heightRight: heightRightIn?.toString(),
        legHeight: legHeightIn?.toString(),
      });

      if (configName) {
        geometricArea = new Decimal(
          areaPerimeterFor(configName, dimensionsFt).areaFt2,
        );
      } else if (heightIn) {
        geometricArea = widthIn.mul(heightIn).div(144);
      }
    }

    const rectangularArea =
      explicitAreaSqFt ??
      (widthIn && heightIn ? widthIn.mul(heightIn).div(144) : null);

    let billableQuantity: Decimal;
    switch (input.service.billingUnit) {
      case InstallationBillingUnit.UNIT:
        billableQuantity = new Decimal(1);
        break;
      case InstallationBillingUnit.PANEL:
        if (!Number.isInteger(panelCount) || Number(panelCount) < 1) {
          throw new BadRequestException(
            `Panel Count is required for service "${input.service.name}".`,
          );
        }
        billableQuantity = new Decimal(Number(panelCount));
        break;
      case InstallationBillingUnit.SQFT:
        billableQuantity = this.requirePositive(
          geometricArea,
          `Area for service "${input.service.name}"`,
        );
        break;
      case InstallationBillingUnit.SQFT_RECTANGULAR:
        billableQuantity = this.requirePositive(
          rectangularArea,
          `Rectangular area for service "${input.service.name}"`,
        );
        break;
      case InstallationBillingUnit.LINEAR_FOOT:
        billableQuantity = this.requirePositive(
          lengthIn,
          `Length for service "${input.service.name}"`,
        ).div(12);
        break;
      default:
        throw new BadRequestException('Unsupported installation billing unit.');
    }

    let metricValue: Decimal | null = null;
    switch (input.service.ruleMetric) {
      case InstallationRuleMetric.NONE:
        break;
      case InstallationRuleMetric.WIDTH:
        metricValue = this.requirePositive(
          widthIn,
          `Width for service "${input.service.name}"`,
        );
        break;
      case InstallationRuleMetric.HEIGHT:
        metricValue = this.requirePositive(
          heightIn,
          `Height for service "${input.service.name}"`,
        );
        break;
      case InstallationRuleMetric.AREA:
        metricValue = this.requirePositive(
          input.service.billingUnit === InstallationBillingUnit.SQFT_RECTANGULAR
            ? rectangularArea
            : geometricArea,
          `Area for service "${input.service.name}"`,
        );
        break;
      case InstallationRuleMetric.PANEL_COUNT:
        if (!Number.isInteger(panelCount) || Number(panelCount) < 1) {
          throw new BadRequestException(
            `Panel Count is required to select a rule for service "${input.service.name}".`,
          );
        }
        metricValue = new Decimal(Number(panelCount));
        break;
      case InstallationRuleMetric.LENGTH:
        metricValue = this.requirePositive(
          lengthIn,
          `Length for service "${input.service.name}"`,
        );
        break;
      default:
        throw new BadRequestException('Unsupported installation rule metric.');
    }

    const activeRules = input.service.rules
      .filter((rule) => rule.isActive)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);

    let selectedRule: InstallationServiceForPricing['rules'][number] | null = null;
    if (metricValue && activeRules.length > 0) {
      const matches = activeRules.filter((rule) =>
        this.matchesRule(metricValue!, rule),
      );
      if (matches.length !== 1) {
        throw new BadRequestException(
          `Service "${input.service.name}" has ${matches.length === 0 ? 'no rule' : 'ambiguous rules'} for metric ${metricValue.toString()}.`,
        );
      }
      selectedRule = matches[0];
    }

    const rate = new Decimal(
      (selectedRule?.rate ?? input.service.baseRate).toString(),
    );
    const occurrences = input.occurrences ?? 1;
    if (!Number.isInteger(occurrences) || occurrences < 1) {
      throw new BadRequestException('Occurrences must be a whole number greater than zero.');
    }

    const baseAmount = rate
      .mul(billableQuantity)
      .mul(occurrences)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const multiplier = new Decimal(1).add(
      input.profile.adjustmentPercent.div(100),
    );
    const adjustedAmount = baseAmount
      .mul(multiplier)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    return {
      serviceId: input.service.id,
      ruleId: selectedRule?.id ?? null,
      measurementId: input.measurementId ?? null,
      origin: input.origin,
      sourceSystemId: input.sourceSystemId ?? null,
      sourceConfigId: input.sourceConfigId ?? null,
      componentIndex: input.componentIndex ?? null,
      componentLabel: input.componentLabel ?? null,
      serviceNameSnapshot: input.service.name,
      billingUnitSnapshot: input.service.billingUnit,
      ruleMetricSnapshot: input.service.ruleMetric,
      ruleSnapshot: selectedRule
        ? ({
            id: selectedRule.id,
            minValue: selectedRule.minValue?.toString() ?? null,
            minInclusive: selectedRule.minInclusive,
            maxValue: selectedRule.maxValue?.toString() ?? null,
            maxInclusive: selectedRule.maxInclusive,
            rate: selectedRule.rate.toString(),
          } as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      widthIn: widthIn ? new Prisma.Decimal(widthIn.toString()) : null,
      heightIn: heightIn ? new Prisma.Decimal(heightIn.toString()) : null,
      areaSqFt: geometricArea.gt(0)
        ? new Prisma.Decimal(geometricArea.toFixed(4))
        : null,
      panelCount,
      lengthIn: lengthIn ? new Prisma.Decimal(lengthIn.toString()) : null,
      metricValue: metricValue
        ? new Prisma.Decimal(metricValue.toFixed(4))
        : null,
      rate: new Prisma.Decimal(rate.toFixed(4)),
      billableQuantity: new Prisma.Decimal(billableQuantity.toFixed(4)),
      occurrences,
      baseAmount: new Prisma.Decimal(baseAmount.toFixed(2)),
      adjustmentPercent: new Prisma.Decimal(
        input.profile.adjustmentPercent.toFixed(4),
      ),
      adjustedAmount: new Prisma.Decimal(adjustedAmount.toFixed(2)),
      description: input.description?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
    } satisfies Prisma.InstallationQuoteLineUncheckedCreateWithoutQuoteInput;
  }
}

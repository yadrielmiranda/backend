import {
  InstallationBillingUnit,
  InstallationLineOrigin,
  InstallationRuleMetric,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { InstallationPricingService } from './installation-pricing.service';

describe('InstallationPricingService', () => {
  const pricing = new InstallationPricingService({} as never);
  const profile = {
    id: 1,
    name: 'Dealer',
    adjustmentPercent: new Decimal(10),
    minimumCharge: new Decimal(1000),
  };

  it('selects one contiguous width rule and applies the profile once', () => {
    const service = {
      id: 1,
      name: 'Configured service',
      description: null,
      billingUnit: InstallationBillingUnit.UNIT,
      ruleMetric: InstallationRuleMetric.WIDTH,
      baseRate: new Prisma.Decimal(0),
      minimumCharge: new Prisma.Decimal(0),
      availableForRequest: true,
      availableForField: true,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      rules: [
        {
          id: 1,
          serviceId: 1,
          minValue: null,
          minInclusive: true,
          maxValue: new Prisma.Decimal(53),
          maxInclusive: false,
          rate: new Prisma.Decimal(100),
          sortOrder: 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          serviceId: 1,
          minValue: new Prisma.Decimal(53),
          minInclusive: true,
          maxValue: null,
          maxInclusive: false,
          rate: new Prisma.Decimal(150),
          sortOrder: 1,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    const line = pricing.calculateLine({
      service,
      profile,
      origin: InstallationLineOrigin.AUTO,
      dimensions: { widthIn: 53, heightIn: 50, configName: 'Picture' },
    });

    expect(line.ruleId).toBe(2);
    expect(line.baseAmount.toString()).toBe('150');
    expect(line.adjustedAmount.toString()).toBe('165');
  });

  it('uses only panelCount for PANEL billing', () => {
    const service = {
      id: 2,
      name: 'Panel service',
      description: null,
      billingUnit: InstallationBillingUnit.PANEL,
      ruleMetric: InstallationRuleMetric.NONE,
      baseRate: new Prisma.Decimal(40),
      minimumCharge: new Prisma.Decimal(0),
      availableForRequest: true,
      availableForField: true,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      rules: [],
    };

    const line = pricing.calculateLine({
      service,
      profile: { ...profile, adjustmentPercent: new Decimal(0) },
      origin: InstallationLineOrigin.AUTO,
      dimensions: { panelCount: 3, widthIn: 100, heightIn: 80 },
    });

    expect(line.billableQuantity.toString()).toBe('3');
    expect(line.adjustedAmount.toString()).toBe('120');
  });

  it('uses manually entered square feet without an estimate opening', () => {
    const service = {
      id: 3,
      name: 'Concrete cutting',
      description: null,
      billingUnit: InstallationBillingUnit.SQFT,
      ruleMetric: InstallationRuleMetric.AREA,
      baseRate: new Prisma.Decimal(0),
      minimumCharge: new Prisma.Decimal(0),
      availableForRequest: true,
      availableForField: true,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      rules: [
        {
          id: 3,
          serviceId: 3,
          minValue: null,
          minInclusive: true,
          maxValue: null,
          maxInclusive: false,
          rate: new Prisma.Decimal(25),
          sortOrder: 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    const line = pricing.calculateLine({
      service,
      profile: { ...profile, adjustmentPercent: new Decimal(0) },
      origin: InstallationLineOrigin.FIELD_ADDED,
      dimensions: { areaSqFt: 8.5 },
      occurrences: 2,
    });

    expect(line.measurementId).toBeNull();
    expect(line.areaSqFt?.toString()).toBe('8.5');
    expect(line.metricValue?.toString()).toBe('8.5');
    expect(line.billableQuantity.toString()).toBe('8.5');
    expect(line.baseAmount.toString()).toBe('425');
  });

  it('applies one minimum to the combined total of each service', () => {
    const result = pricing.calculateServiceMinimums([
      {
        serviceId: 1,
        serviceName: 'Concrete cutting',
        minimumCharge: new Prisma.Decimal(1000),
        adjustedAmount: new Prisma.Decimal(350),
      },
      {
        serviceId: 1,
        serviceName: 'Concrete cutting',
        minimumCharge: new Prisma.Decimal(1000),
        adjustedAmount: new Prisma.Decimal(250),
      },
      {
        serviceId: 2,
        serviceName: 'Window installation',
        minimumCharge: new Prisma.Decimal(200),
        adjustedAmount: new Prisma.Decimal(250),
      },
    ]);

    expect(result.totalAdjustment.toString()).toBe('400');
    expect(result.snapshot).toEqual([
      {
        serviceId: 1,
        serviceName: 'Concrete cutting',
        minimumCharge: '1000.00',
        calculatedAmount: '600.00',
        adjustment: '400.00',
      },
      {
        serviceId: 2,
        serviceName: 'Window installation',
        minimumCharge: '200.00',
        calculatedAmount: '250.00',
        adjustment: '0.00',
      },
    ]);
  });
});

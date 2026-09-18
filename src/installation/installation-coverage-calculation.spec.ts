import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import {
  InstallationCoverageCalculationService,
  installationSurcharge,
  installationBaseForSurcharge,
  CoverageSnapshot,
} from './installation-coverage-calculation.service';
import { RequestInstallationDto } from './dto/installation-workflow.dto';
import { InstallationWorkflowService } from './installation-workflow.service';
import { InstallationPricingService } from './installation-pricing.service';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { buildEstimateInstallationSummary } from '@/estimates/reporting/estimate-installation-summary';
import { agreementScopes } from '@/contracts/agreement-content';

const address = {
  street: '123 Customer St',
  city: 'Miami',
  state: 'FL',
  postalCode: '33101',
};
const policy = {
  revision: 7,
  originStreet: '999 PRIVATE BASE',
  originCity: 'Miami',
  originState: 'FL',
  originPostalCode: '33175',
  includedMiles: new Prisma.Decimal(25),
  maxDistanceMiles: new Prisma.Decimal(75),
  ranges: [
    { fromMiles: '25', upToMiles: '50', chargeType: 'FIXED', value: '150' },
    { fromMiles: '50', upToMiles: '75', chargeType: 'PERCENTAGE', value: '15' },
  ],
};
function fixture(distanceMeters = 80468) {
  const prisma: any = {
    installationCoverage: { findUnique: jest.fn().mockResolvedValue(policy) },
  };
  const addresses: any = {
    validateDeliveryAddress: jest
      .fn()
      .mockResolvedValue({ ...address, placeId: 'private-place-id' }),
  };
  const routes: any = {
    calculateDrivingRoute: jest.fn().mockResolvedValue({ distanceMeters }),
  };
  return {
    prisma,
    addresses,
    routes,
    service: new InstallationCoverageCalculationService(
      prisma,
      addresses,
      routes,
    ),
  };
}
const fixed: CoverageSnapshot = {
  schema: 1,
  revision: 7,
  origin: address,
  destination: { ...address, placeId: 'private' },
  distanceMeters: 80468,
  maximumMiles: '75',
  includedMiles: '25',
  range: { type: 'FIXED', value: '150', fromMiles: '25', upToMiles: '50' },
};

describe('Installation coverage calculation', () => {
  it.each(['GA', 'CA', 'NY'])('rejects %s before any Google request', async state => {
    const f = fixture();
    await expect(f.service.prepare({ ...address, state })).rejects.toThrow('Installation is available only in Florida.');
    expect(f.addresses.validateDeliveryAddress).not.toHaveBeenCalled();
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
    expect(f.prisma.installationCoverage.findUnique).not.toHaveBeenCalled();
    const dto = plainToInstance(RequestInstallationDto, { permitRequested: false, installationAddress: { ...address, state }, installationAddressConfirmed: true });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
  it('accepts and normalizes a Florida state code', async () => {
    const f = fixture();
    const result = await f.service.prepare({ ...address, state: ' fl ' });
    expect(result.address.state).toBe('FL');
    expect(f.addresses.validateDeliveryAddress).toHaveBeenCalledWith(address);
  });

  it.each([
    [0, 'NONE'],
    [40233, 'NONE'],
    [40234, 'FIXED'],
    [80467, 'FIXED'],
    [80468, 'PERCENTAGE'],
    [120700, 'PERCENTAGE'],
  ])(
    'matches %s meters without rounding the mileage',
    async (meters, expected) => {
      const f = fixture(Number(meters));
      const result = await f.service.prepare(address);
      expect(result.snapshot.range.type).toBe(expected);
      expect(result.address).toEqual(address);
      expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(
        {
          street: policy.originStreet,
          city: 'Miami',
          state: 'FL',
          postalCode: '33175',
        },
        { ...address, placeId: 'private-place-id' },
      );
    },
  );
  it('includes the exact maximum and rejects the next meter', async () => {
    const f = fixture(1609344);
    f.prisma.installationCoverage.findUnique.mockResolvedValue({
      ...policy,
      maxDistanceMiles: new Prisma.Decimal(1000),
      includedMiles: new Prisma.Decimal(1000),
      ranges: [],
    });
    expect((await f.service.prepare(address)).snapshot.range.type).toBe('NONE');
    f.routes.calculateDrivingRoute.mockResolvedValue({
      distanceMeters: 1609345,
    });
    await expect(f.service.prepare(address)).rejects.toThrow(
      'Installation is not available at this address.',
    );
  });
  it('rejects out-of-area addresses without a calculated quote', async () => {
    await expect(fixture(120701).service.prepare(address)).rejects.toThrow(
      'Installation is not available at this address.',
    );
  });
  it('requires saved configuration and complete input', async () => {
    const f = fixture();
    await expect(
      f.service.prepare({ ...address, street: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.prisma.installationCoverage.findUnique.mockResolvedValue(null);
    await expect(f.service.prepare(address)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
  });
  it.each([NaN, -1, Infinity, 4.5])(
    'rejects invalid distance %s',
    async (distance) => {
      await expect(
        fixture(distance).service.prepare(address),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );
  it('does not leak provider details or fall back to free installation', async () => {
    const f = fixture();
    f.routes.calculateDrivingRoute.mockRejectedValue(
      new Error('999 PRIVATE BASE; api-key=secret'),
    );
    await expect(f.service.prepare(address)).rejects.toThrow(
      'temporarily unavailable',
    );
    try {
      await f.service.prepare(address);
    } catch (error) {
      expect(String(error)).not.toMatch(/PRIVATE|secret/);
    }
    f.addresses.validateDeliveryAddress.mockRejectedValue(
      new BadRequestException('Invalid private provider response'),
    );
    await expect(f.service.prepare(address)).rejects.toThrow(
      'We could not verify this installation address',
    );
  });
  it('refuses an outdated configuration at commit time', async () => {
    const f = fixture();
    f.prisma.installationCoverage.findUnique.mockResolvedValue({ revision: 8 });
    await expect(
      f.service.assertCurrent(fixed, f.prisma),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('calculates one fixed charge or percentage with cent rounding', () => {
    expect(installationSurcharge(new Decimal(2000), fixed).toFixed(2)).toBe(
      '150.00',
    );
    expect(
      installationSurcharge(new Decimal('123.45'), {
        ...fixed,
        range: { ...fixed.range, type: 'PERCENTAGE', value: '15' },
      }).toFixed(2),
    ).toBe('18.52');
    expect(
      installationSurcharge(new Decimal(2000), {
        ...fixed,
        range: { ...fixed.range, type: 'NONE' },
      }).toFixed(2),
    ).toBe('0.00');
  });
  it('excludes extra services and their exclusive minimum adjustments', () => {
    const lines = [
      { serviceId: 1, origin: 'AUTO', adjustedAmount: new Decimal(1000) },
      {
        serviceId: 2,
        origin: 'USER_SELECTED',
        adjustedAmount: new Decimal(200),
      },
      { serviceId: 1, origin: 'FIELD_ADDED', adjustedAmount: new Decimal(50) },
    ];
    const base = installationBaseForSurcharge(new Decimal(1400), lines, [
      { serviceId: 2, adjustment: '100' },
      { serviceId: 1, adjustment: '50' },
    ]);
    expect(base.toFixed(2)).toBe('1050.00');
  });
  it('recalculates totals without accumulating the surcharge or using new tariffs', async () => {
    const lines = [
      {
        serviceId: 1,
        origin: 'AUTO',
        serviceNameSnapshot: 'Installation',
        baseAmount: new Prisma.Decimal(1000),
        adjustedAmount: new Prisma.Decimal(1000),
        service: { minimumCharge: new Prisma.Decimal(0) },
      },
      {
        serviceId: 2,
        origin: 'USER_SELECTED',
        serviceNameSnapshot: 'Extra',
        baseAmount: new Prisma.Decimal(200),
        adjustedAmount: new Prisma.Decimal(200),
        service: { minimumCharge: new Prisma.Decimal(300) },
      },
    ];
    const quote: any = {
      id: 1,
      jobId: 1,
      version: 1,
      profileMinimumSnapshot: new Prisma.Decimal(0),
      lines,
      job: { installationAddressConfirmedAt: new Date() },
      coverageSnapshot: {
        data: {
          ...fixed,
          range: { ...fixed.range, type: 'PERCENTAGE', value: '15' },
        },
      },
    };
    const tx: any = {
      installationQuote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(async ({ data }) => Object.assign(quote, data)),
      },
    };
    const pricing = new InstallationPricingService({} as never);
    const workflow: any = new InstallationWorkflowService(
      {} as never,
      pricing,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (let n = 0; n < 2; n++) {
      const result = await workflow.recalculateQuoteTotals(1, tx);
      expect(result.installationSurcharge.toString()).toBe('150');
      expect(result.total.toString()).toBe('1450');
    }
    const summary = buildEstimateInstallationSummary({
      status: 'REQUESTED',
      installationAddress: address,
      quotes: [quote],
      permit: null,
    } as any)!;
    expect(summary.installationAmount).toBe('1150.00');
    expect(summary.installationSurcharge).toBe('150.00');
    expect(summary.additionalServices[0].amount).toBe('300.00');
    expect(summary.installationTotal).toBe('1450.00');
    quote.coverageSnapshot = null;
    await expect(workflow.recalculateQuoteTotals(1, tx)).rejects.toThrow(
      'must be verified',
    );
    quote.job.installationAddressConfirmedAt = null;
    expect(
      (await workflow.recalculateQuoteTotals(1, tx)).total.toString(),
    ).toBe('1300');
  });
  it.each(['client', 'dealer', 'operator', undefined] as const)(
    'removes private coverage even from nested API data for %s',
    (role) => {
      const response = presentApiResponse(
        {
          installationJob: {
            installationAddress: address,
            quotes: [
              {
                total: '1150.00',
                installationSurcharge: '150.00',
                coverageSnapshot: { data: policy },
              },
            ],
          },
        },
        role ? { id: 1, role: { name: role } } : undefined,
      );
      expect(response.installationJob.quotes[0].installationSurcharge).toBe(
        '150.00',
      );
      expect(JSON.stringify(response)).not.toMatch(
        /PRIVATE|originStreet|includedMiles|coverageSnapshot/,
      );
    },
  );
  it('binds the signed scope to the installation address even when the price stays the same', () => {
    const snapshot = {
      installationSummary: {
        installationAddress: address,
        installationAmount: '1150.00',
        installationSurcharge: '150.00',
        additionalServices: [],
      },
    };
    const first = agreementScopes(snapshot);
    const second = agreementScopes({
      ...snapshot,
      installationSummary: {
        ...snapshot.installationSummary,
        installationAddress: { ...address, street: '999 Other St' },
      },
    });
    expect(first.materialHash).not.toBe(second.materialHash);
    expect(first.charges.total).toBe('1150.00');
    expect(
      first.charges.lines.map((line) => [line.description, line.amount]),
    ).toEqual([
      ['Installation', '1000.00'],
      ['Installation surcharge', '150.00'],
    ]);
  });
  it('requires explicit confirmation and validates the nested address', async () => {
    const input = {
      permitRequested: false,
      installationAddress: address,
      installationAddressConfirmed: true,
    };
    expect(
      await validate(plainToInstance(RequestInstallationDto, input)),
    ).toHaveLength(0);
    for (const bad of [
      { ...input, installationAddressConfirmed: false },
      { ...input, installationAddress: undefined },
      { ...input, installationAddress: { ...address, state: 'XX' } },
    ]) {
      expect(
        (await validate(plainToInstance(RequestInstallationDto, bad))).length,
      ).toBeGreaterThan(0);
    }
  });
});

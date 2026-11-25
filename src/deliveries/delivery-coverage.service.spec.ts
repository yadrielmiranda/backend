import { Prisma } from '@prisma/client';
import { DeliveryCoverageService } from './delivery-coverage.service';
import { METERS_PER_MILE } from './delivery-pricing';

const destination = {
  street: '123 Example St',
  city: 'Orlando',
  state: 'FL',
  postalCode: '32801',
};

function fixture(distanceMeters = 201168, pricing: {
  basePrice: string | null; includedMiles: string | null; additionalMilePrice: string | null;
} = { basePrice: null, includedMiles: null, additionalMilePrice: null }) {
  const configuration = {
    id: 1,
    revision: 1,
    street: '100 Warehouse Road',
    city: 'Miami',
    state: 'FL',
    postalCode: '33101',
    maxDeliveryMiles: new Prisma.Decimal(125),
  };
  const warehouse = {
    find: jest.fn(async () => ({
      configuration,
      pricing,
    })),
  };
  const addressValidation = {
    validateDeliveryAddress: jest.fn(async (value) => ({
      ...value,
      placeId: 'place-1',
    })),
  };
  const routes = {
    calculateDrivingRoute: jest.fn(async () => ({
      provider: 'GOOGLE_ROUTES',
      distanceMeters,
      duration: null,
    })),
  };
  const service = new DeliveryCoverageService(
    warehouse as any,
    addressValidation as any,
    routes as any,
  );
  return { service, warehouse, addressValidation, routes, configuration };
}

describe('DeliveryCoverageService', () => {
  it('uses the configured warehouse as the origin and accepts the exact maximum', async () => {
    const f = fixture(201168);
    await expect(f.service.checkAddress(destination)).resolves.toEqual({
      available: true,
    });
    expect(f.addressValidation.validateDeliveryAddress).toHaveBeenCalledWith(
      destination,
    );
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(
      {
        street: f.configuration.street,
        city: f.configuration.city,
        state: f.configuration.state,
        postalCode: f.configuration.postalCode,
      },
      expect.objectContaining({ ...destination, placeId: 'place-1' }),
    );
  });

  it('reports unavailable one meter beyond the configured maximum', async () => {
    const f = fixture(201169);
    await expect(f.service.checkAddress(destination)).resolves.toEqual({
      available: false,
    });
  });

  it('enables address review and routes using the exact confirmed property location', async () => {
    const f = fixture();
    const confirmedLocation = { lat: 25.78, lng: -80.19 };
    const entered = { ...destination, confirmedLocation };
    await expect(f.service.checkAddressWithRevision(entered)).resolves.toEqual({ available: true, revision: 1, confirmedLocation, estimatedPrice: null });
    expect(f.addressValidation.validateDeliveryAddress).toHaveBeenCalledWith(entered,
      { suggestCorrections: true, allowLocationConfirmation: true });
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(expect.anything(), { ...entered, placeId: 'place-1' });
  });

  it('can check an address when a pricing parameter is missing or invalid', async () => {
    for (const rate of [null, '-1', 'broken', 'Infinity']) {
      const f = fixture(1000, { basePrice: '500', includedMiles: rate, additionalMilePrice: '5' });
      await expect(f.service.checkAddressWithRevision(destination)).resolves.toMatchObject({ available: true, estimatedPrice: null });
    }
  });

  it('uses the verified one-way route once and preserves precision when allocating the displayed mileage charge', async () => {
    const rates = { basePrice: '149.9951', includedMiles: '50.2575', additionalMilePrice: '5.4321' };
    const f = fixture(METERS_PER_MILE.mul('55.60').round().toNumber(), rates);
    await expect(f.service.checkAddressWithRevision(destination)).resolves.toMatchObject({
      available: true, estimatedPrice: { total: '179.00', basePrice: '150.00', includedMiles: '50.2575',
        additionalMiles: '5.34', additionalMilePrice: '5.4321', additionalMileageCharge: '29.00' },
    });
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledTimes(1);
    expect(f.addressValidation.validateDeliveryAddress).toHaveBeenCalledTimes(1);
    expect(f.warehouse.find).toHaveBeenCalledTimes(1);
    await expect(fixture(201169, rates).service.checkAddressWithRevision(destination)).resolves.toMatchObject({
      available: false, estimatedPrice: null,
    });
  });

  it('does not call Google when Warehouse & Delivery is not configured', async () => {
    const f = fixture();
    f.warehouse.find.mockResolvedValue({
      configuration: null,
      pricing: {
        basePrice: null,
        includedMiles: null,
        additionalMilePrice: null,
      },
    } as any);
    await expect(f.service.checkAddress(destination)).rejects.toThrow(
      'Delivery is currently unavailable',
    );
    expect(f.addressValidation.validateDeliveryAddress).not.toHaveBeenCalled();
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
  });
});

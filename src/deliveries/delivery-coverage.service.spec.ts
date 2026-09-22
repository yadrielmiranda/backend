import { Prisma } from '@prisma/client';
import { DeliveryCoverageService } from './delivery-coverage.service';

const destination = {
  street: '123 Example St',
  city: 'Orlando',
  state: 'FL',
  postalCode: '32801',
};

function fixture(distanceMeters = 201168) {
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
      pricing: {
        basePrice: null,
        includedMiles: null,
        additionalMilePrice: null,
      },
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

import { DeliveryType, Prisma } from '@prisma/client';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { calculateDeliveryPricing } from './delivery-pricing';
import { CreateDeliveryDto } from './dto/delivery.dto';
import { AddressLocationRequiredException } from './google-address-validation.service';
import { presentApiResponse } from '@/common/response-privacy.interceptor';

const actor: any = { id: 1, role: { name: 'admin' } };
const address = {
  street: '100 Warehouse Road',
  city: 'Miami',
  state: 'FL',
  postalCode: '33101',
};

function fixture(distanceMeters = 160934) {
  const configuration = {
    ...address,
    id: 1,
    revision: 2,
    maxDeliveryMiles: new Prisma.Decimal(150),
  };
  const pricing = {
    basePrice: '600',
    includedMiles: '60',
    additionalMilePrice: '5',
  };
  const order: any = {
    id: 40,
    idEst: 7,
    number: 'ORD-40',
    userId: 2,
    status: { name: 'Ready to pick up' },
    user: {
      id: 2,
      role: { name: 'client' },
      isTaxExempt: false,
      street: '90 Destination Road',
      city: 'Orlando',
      state: 'FL',
      postalCode: '32801',
    },
    estimate: { installationJob: null },
    deliveries: [],
  };
  const db: any = {
    factoryPickupRunOrder: { findFirst: jest.fn(async () => null) },
    warehouseStock: { findMany: jest.fn(async () => []) },
    order: {
      findUnique: jest.fn(async () => order),
      update: jest.fn(async ({ data }) => ({ ...order, ...data })),
    },
    globalParameter: {
      findUnique: jest.fn(async () => ({ value: new Prisma.Decimal('0.07') })),
    },
    warehouseDeliverySettings: {
      findUnique: jest.fn(async () => configuration),
    },
    orderDelivery: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => ({ id: 9, ...data })),
      update: jest.fn(),
    },
  };
  db.$transaction = jest.fn(async (run) => run(db));
  const routes = {
    calculateDrivingRoute: jest.fn(async () => ({
      distanceMeters,
      provider: 'GOOGLE_ROUTES',
    })),
  };
  const validation = {
    validateDeliveryAddress: jest.fn(async (destination) => destination),
  };
  const warehouse = { find: jest.fn(async () => ({ configuration, pricing })) };
  const notifications = {
    createAndSend: jest.fn(),
    createAndSendToRoles: jest.fn(),
  };
  const service = new DeliveriesService(
    db,
    routes as any,
    validation as any,
    notifications as any,
    { log: jest.fn() } as any,
    warehouse as any,
  );
  return {
    service,
    db,
    order,
    routes,
    validation,
    warehouse,
    configuration,
    pricing,
    notifications,
  };
}

describe('Delivery warehouse origin and coverage', () => {
  it.each([
    ['manual address', address],
    ['saved address', {}],
  ])('revalidates the confirmed point for a %s and snapshots only the returned location', async (_label, fields) => {
    const f = fixture(178912);
    const requested = { lat: 25.7542, lng: -80.2271 };
    const verified = { lat: 25.75421, lng: -80.22711 };
    f.order.user.addressLine2 = 'Apartment 2B';
    f.validation.validateDeliveryAddress.mockImplementation(async destination => ({
      ...destination, confirmedLocation: verified, placeId: 'server-verified-place',
    }));
    const result = await f.service.createDelivery(40, {
      ...fields, confirmedLocation: requested, taxable: true,
    }, actor);
    expect(f.validation.validateDeliveryAddress).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedLocation: requested }),
      { suggestCorrections: true, allowLocationConfirmation: true },
    );
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(address,
      expect.objectContaining({ confirmedLocation: verified, placeId: 'server-verified-place' }));
    expect(result.destinationLocation).toEqual(verified);
    expect(result.destinationLocation).not.toEqual(requested);
    const publicResult = presentApiResponse(result, { id: 2, role: { name: 'client' } } as any);
    expect(publicResult.destinationLocation).toEqual(verified);
    expect(Object.keys(publicResult.destinationLocation).sort()).toEqual(['lat', 'lng']);
    expect(publicResult).not.toHaveProperty('placeId');
    expect(result.total.toString()).toBe(calculateDeliveryPricing({
      distanceMeters: 178912, ...f.pricing, taxRate: '0.07',
    }).total.toString());
    if (_label === 'saved address') expect(result.destinationAddressLine2).toBe('Apartment 2B');

    await f.service.createDelivery(40, { ...fields, confirmedLocation: requested }, actor);
    expect(f.validation.validateDeliveryAddress).toHaveBeenCalledTimes(2);
  });

  it('never inherits a stored account location when the delivery request has no confirmed point', async () => {
    const f = fixture();
    f.order.user.confirmedLocation = { lat: 25.75, lng: -80.22 };
    await f.service.createDelivery(40, {}, actor);
    const destination = f.validation.validateDeliveryAddress.mock.calls[0][0];
    expect(destination).not.toHaveProperty('confirmedLocation');
    expect(f.db.orderDelivery.create.mock.calls[0][0].data).not.toHaveProperty('destinationLocation');
  });

  it('does not route or create a charge when revalidation rejects the selected point', async () => {
    const f = fixture();
    const error = new AddressLocationRequiredException({ lat: 25.75, lng: -80.22 });
    f.validation.validateDeliveryAddress.mockRejectedValue(error);
    await expect(f.service.createDelivery(40, { confirmedLocation: { lat: 25.75, lng: -80.22 } }, actor))
      .rejects.toBe(error);
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();
  });

  it('snapshots the warehouse and saved customer detail and allows explicit clearing', async () => {
    const f = fixture();
    (f.configuration as any).addressLine2 = 'Warehouse Suite 5';
    f.order.user.addressLine2 = 'Apartment 2B';
    const saved = await f.service.createDelivery(40, {}, actor);
    expect(saved).toMatchObject({ originAddressLine2: 'Warehouse Suite 5', destinationAddressLine2: 'Apartment 2B' });
    const cleared = await f.service.createDelivery(40, { addressLine2: '   ' }, actor);
    expect(cleared.destinationAddressLine2).toBeNull();
    const manual = await f.service.createDelivery(40, { ...address, addressLine2: '  Rear building, floor 2  ' }, actor);
    expect(manual.destinationAddressLine2).toBe('Rear building, floor 2');
  });
  it('uses the warehouse origin and preserves the existing fractional-mile and tax calculation', async () => {
    const f = fixture(178912);
    const delivery = await f.service.createDelivery(
      40,
      { taxable: true },
      actor,
    );
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ street: '90 Destination Road' }),
    );
    const expected = calculateDeliveryPricing({
      distanceMeters: 178912,
      ...f.pricing,
      taxRate: '0.07',
    });
    expect(delivery.total.toString()).toBe(expected.total.toString());
    expect(delivery.originStreet).toBe(address.street);
    expect(delivery.maxDistanceMilesSnapshot?.toString()).toBe('150');
    expect(delivery.basePriceSnapshot.toString()).toBe('600');
    expect(f.db.orderDelivery.update).not.toHaveBeenCalled();
  });

  it('allows standard delivery from Preparing for pickup', async () => {
    const f = fixture(50000);
    f.order.status.name = 'Preparing for pickup';
    await expect(f.service.createDelivery(40, {}, actor)).resolves.toMatchObject({
      id: 9,
    });
  });

  it('allows an administrator to select factory pickup from Preparing for pickup', async () => {
    const f = fixture(50000);
    f.order.status.name = 'Preparing for pickup';
    const result = await f.service.selectFactoryPickup(40, actor);
    expect(result.order.fulfillmentMethod).toBe('FACTORY_PICKUP');
  });

  it.each(['client', 'dealer', 'operator'])('does not let %s select factory pickup', async (role) => {
    const f = fixture(50000);
    f.order.status.name = 'Preparing for pickup';
    await expect(
      f.service.selectFactoryPickup(40, {
        id: 2,
        role: { name: role },
      } as any),
    ).rejects.toThrow('Only administrators');
    expect(f.db.order.update).not.toHaveBeenCalled();
  });

  it('charges only the base price inside the included miles', async () => {
    const f = fixture(50000);
    const result = await f.service.createDelivery(40, {}, actor);
    expect(result.total.toString()).toBe('600');
    expect(result.additionalMiles.toString()).toBe('0');
  });

  it.each([undefined, { lat: 25.75, lng: -80.22 }])('accepts the exact maximum distance with location %j', async confirmedLocation => {
    const f = fixture(201168);
    f.configuration.maxDeliveryMiles = new Prisma.Decimal(125);
    await expect(
      f.service.createDelivery(40, { confirmedLocation }, actor),
    ).resolves.toMatchObject({ id: 9 });
  });

  it.each([undefined, { lat: 25.75, lng: -80.22 }])('rejects one meter beyond the maximum with location %j even when displayed miles round to the limit', async confirmedLocation => {
    const f = fixture(201169);
    f.configuration.maxDeliveryMiles = new Prisma.Decimal(125);
    await expect(f.service.createDelivery(40, { confirmedLocation }, actor)).rejects.toThrow(
      'outside our delivery coverage',
    );
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();
    expect(f.db.order.update).not.toHaveBeenCalled();
    expect(f.notifications.createAndSend).not.toHaveBeenCalled();
  });

  it.each([
    DeliveryType.INSTALLATION_OVERRIDE,
    DeliveryType.PRE_DELIVERY,
    DeliveryType.REDELIVERY,
  ])('applies the maximum to charged %s deliveries', async (type) => {
    const f = fixture(500000);
    if (type === DeliveryType.REDELIVERY) f.order.status.name = 'Delivered';
    else f.order.estimate.installationJob = { status: 'SCHEDULED' };
    await expect(
      f.service.createDelivery(
        40,
        { type, internalReason: 'Requested by customer' },
        actor,
      ),
    ).rejects.toThrow('outside our delivery coverage');
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();
  });

  it('does not call Google before warehouse setup is completed', async () => {
    const f = fixture();
    f.warehouse.find.mockResolvedValue({
      configuration: null,
      pricing: f.pricing,
    } as any);
    await expect(f.service.createDelivery(40, {}, actor)).rejects.toThrow(
      'Configure Warehouse & Delivery',
    );
    expect(f.validation.validateDeliveryAddress).not.toHaveBeenCalled();
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
  });

  it('rejects a configuration changed while Google was calculating without creating a charge', async () => {
    const f = fixture();
    f.db.warehouseDeliverySettings.findUnique.mockResolvedValue({
      ...f.configuration,
      revision: 3,
    });
    await expect(f.service.createDelivery(40, {}, actor)).rejects.toThrow(
      'settings changed',
    );
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();
  });

  it('does not query routing or settings when the order is not eligible', async () => {
    const f = fixture();
    f.order.status.name = 'Pending';
    await expect(f.service.createDelivery(40, {}, actor)).rejects.toThrow(
      'Preparing for pickup',
    );
    expect(f.warehouse.find).not.toHaveBeenCalled();
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
  });
});

describe('Confirmed delivery location input', () => {
  const pipe = new ValidationPipe({
    transform: true, whitelist: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const validate = (confirmedLocation: unknown) => pipe.transform(
    { confirmedLocation }, { type: 'body', metatype: CreateDeliveryDto },
  );

  it.each([{ lat: -90, lng: -180 }, { lat: 90, lng: 180 }, { lat: 0, lng: 0 }])(
    'preserves finite numeric geographic coordinates %j', async confirmedLocation => {
      await expect(validate(confirmedLocation)).resolves.toMatchObject({ confirmedLocation });
    },
  );

  it.each([
    null, [], {}, { latitude: 25, longitude: -80 },
    { lat: '25.75', lng: -80 }, { lat: 25, lng: '-80' },
    { lat: true, lng: -80 }, { lat: null, lng: -80 },
    { lat: NaN, lng: -80 }, { lat: 25, lng: Infinity },
    { lat: 90.001, lng: -80 }, { lat: -90.001, lng: -80 },
    { lat: 25, lng: 180.001 }, { lat: 25, lng: -180.001 },
  ])('rejects invalid or coerced location %j', async confirmedLocation => {
    await expect(validate(confirmedLocation)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps legacy delivery requests without a location valid', async () => {
    await expect(pipe.transform({}, { type: 'body', metatype: CreateDeliveryDto })).resolves.toEqual({});
  });
});

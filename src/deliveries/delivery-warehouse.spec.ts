import { DeliveryType, Prisma } from '@prisma/client';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';
import { AddressConfirmationsController } from './address-confirmations.controller';
import { calculateDeliveryPricing } from './delivery-pricing';
import { CreateDeliveryDto } from './dto/delivery.dto';
import { AddressCorrectionRequiredException, AddressLocationRequiredException } from './google-address-validation.service';
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
    const controller = new DeliveriesController(f.service);
    await expect(controller.createDelivery(40, { confirmedLocation: { lat: 25.75, lng: -80.22 } }, { user: actor } as any))
      .rejects.toBe(error);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      code: 'ADDRESS_LOCATION_CONFIRMATION_REQUIRED',
      message: 'Confirm the property location on the map before continuing.',
      center: { lat: 25.75, lng: -80.22 },
      maxAdjustmentMeters: 500,
    });
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();
  });

  it.each([
    DeliveryType.STANDARD, DeliveryType.PRE_DELIVERY,
    DeliveryType.INSTALLATION_OVERRIDE, DeliveryType.REDELIVERY,
  ])('preserves an actionable correction at final %s calculation and waits for fresh confirmation', async type => {
    const f = fixture();
    if (type === DeliveryType.PRE_DELIVERY || type === DeliveryType.INSTALLATION_OVERRIDE) {
      f.order.estimate.installationJob = { id: 8, status: 'DEPOSIT_PAYMENT_PENDING' };
    }
    if (type === DeliveryType.REDELIVERY) f.order.status.name = 'Delivered';
    const controller = new DeliveriesController(f.service);
    const review = new AddressConfirmationsController(f.validation as any);
    const requested = { ...address, addressLine2: 'LOT 132', confirmedLocation: { lat: 25.75, lng: -80.22 } };
    const suggested = { ...address, addressLine2: 'LOT 132', city: 'Miami Gardens' };
    f.validation.validateDeliveryAddress.mockResolvedValueOnce({ ...requested, placeId: 'review-only-place' });
    await expect(review.review({ purpose: 'DELIVERY', address: requested }))
      .resolves.toEqual({ status: 'VALIDATED', address: requested });

    const correction = new AddressCorrectionRequiredException({
      ...suggested, confirmedLocation: requested.confirmedLocation,
      placeId: 'private-provider-place', providerMetadata: 'private-provider-data',
    } as any);
    f.validation.validateDeliveryAddress.mockRejectedValueOnce(correction);
    const failed = await controller.createDelivery(40, {
      ...requested, type, internalReason: 'Requested delivery',
    }, { user: actor } as any).catch(error => error);
    expect(failed).toBe(correction);
    expect(failed.getStatus()).toBe(400);
    const body = failed.getResponse();
    expect(body).toEqual({
      code: 'ADDRESS_CONFIRMATION_REQUIRED',
      message: 'Confirm the suggested address before continuing.',
      suggestedAddress: suggested,
    });
    expect(JSON.stringify(body)).not.toMatch(/placeId|confirmedLocation|providerMetadata|private-provider/);
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.orderDelivery.create).not.toHaveBeenCalled();

    f.validation.validateDeliveryAddress.mockImplementation(async destination => ({ ...destination, placeId: 'freshly-confirmed-place' }));
    const reconfirmed = await review.review({ purpose: 'DELIVERY', address: body.suggestedAddress });
    expect(reconfirmed).toEqual({ status: 'VALIDATED', address: suggested });
    const created = await controller.createDelivery(40, {
      ...suggested, type, internalReason: 'Requested delivery',
    }, { user: actor } as any);
    expect(f.validation.validateDeliveryAddress).toHaveBeenCalledTimes(4);
    expect(f.validation.validateDeliveryAddress).toHaveBeenLastCalledWith(suggested, {
      suggestCorrections: true, allowLocationConfirmation: true,
    });
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledTimes(1);
    expect(f.routes.calculateDrivingRoute).toHaveBeenCalledWith(address, { ...suggested, placeId: 'freshly-confirmed-place' });
    expect(f.db.orderDelivery.create).toHaveBeenCalledTimes(1);
    expect(created.destinationCity).toBe(suggested.city);
    expect(created).not.toHaveProperty('destinationLocation');
  });

  it('keeps final invalid-address rejection separate from confirmation and creates no charge', async () => {
    const f = fixture();
    const controller = new DeliveriesController(f.service);
    const invalid = new BadRequestException('We could not verify the address exactly as entered.');
    f.validation.validateDeliveryAddress.mockRejectedValueOnce(invalid);
    const error = await controller.createDelivery(40, address, { user: actor } as any).catch(value => value);
    expect(error).toBe(invalid);
    expect(error.getResponse()).not.toHaveProperty('suggestedAddress');
    expect(error.getResponse()).not.toMatchObject({ code: 'ADDRESS_CONFIRMATION_REQUIRED' });
    expect(error.getResponse()).not.toMatchObject({ code: 'ADDRESS_LOCATION_CONFIRMATION_REQUIRED' });
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
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

  it('uses the invited root dealer’s saved tax for a taxable delivery', async () => {
    const f = fixture(50000);
    Object.assign(f.order.user, { dealerMode: 'EXTERNAL', parentDealerId: null, networkTaxRate: new Prisma.Decimal('.07') });
    f.db.globalParameter.findUnique.mockResolvedValue({ value: new Prisma.Decimal('.08') });
    const delivery = await f.service.createDelivery(40, { taxable: true }, actor);
    const expected = calculateDeliveryPricing({ distanceMeters: 50000, ...f.pricing, taxRate: '0.07' });
    expect(delivery.total.toString()).toBe(expected.total.toString());
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

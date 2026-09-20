import { DeliveryType, Prisma } from '@prisma/client';
import { DeliveriesService } from './deliveries.service';
import { calculateDeliveryPricing } from './delivery-pricing';

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

  it('charges only the base price inside the included miles', async () => {
    const f = fixture(50000);
    const result = await f.service.createDelivery(40, {}, actor);
    expect(result.total.toString()).toBe('600');
    expect(result.additionalMiles.toString()).toBe('0');
  });

  it('accepts the exact maximum distance', async () => {
    const f = fixture(201168);
    f.configuration.maxDeliveryMiles = new Prisma.Decimal(125);
    await expect(
      f.service.createDelivery(40, {}, actor),
    ).resolves.toMatchObject({ id: 9 });
  });

  it('rejects one meter beyond the maximum even when the displayed miles would round to the limit', async () => {
    const f = fixture(201169);
    f.configuration.maxDeliveryMiles = new Prisma.Decimal(125);
    await expect(f.service.createDelivery(40, {}, actor)).rejects.toThrow(
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
      'Ready to pick up',
    );
    expect(f.warehouse.find).not.toHaveBeenCalled();
    expect(f.routes.calculateDrivingRoute).not.toHaveBeenCalled();
  });
});

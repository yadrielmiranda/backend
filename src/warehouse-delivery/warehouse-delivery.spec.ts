import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { GlobalParameterKey, Prisma } from '@prisma/client';
import * as request from 'supertest';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { GlobalParametersService } from '@/global-parameters/global-parameters.service';
import { WarehouseDeliveryController } from './warehouse-delivery.controller';
import { WarehouseDeliveryService } from './warehouse-delivery.service';
import { DELIVERY_PARAMETER_KEYS } from './warehouse-delivery.constants';

const valid = () => ({
  revision: 0,
  street: ' 100 Warehouse Road ',
  city: ' Miami ',
  state: 'fl',
  postalCode: '33101',
  maxDeliveryMiles: 150,
  basePrice: 600,
  includedMiles: 60,
  additionalMilePrice: 5,
});

// HTTP, permisos, DTO y servicio reales con almacenamiento aislado y reversible.
describe('Warehouse & Delivery settings', () => {
  let app: INestApplication;
  let stored: any;
  let parameters: Map<string, any>;
  let failPricing = false;
  const db: any = {
    warehouseDeliverySettings: {
      findUnique: jest.fn(
        async ({ select }) =>
          stored &&
          (select
            ? Object.fromEntries(
                Object.keys(select).map((key) => [key, stored[key]]),
              )
            : { ...stored }),
      ),
      create: jest.fn(async ({ data }) => {
        if (stored)
          throw new Prisma.PrismaClientKnownRequestError('Already configured', {
            code: 'P2002',
            clientVersion: '6.18.0',
          });
        stored = { ...data, createdAt: new Date(), updatedAt: new Date() };
        return stored;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!stored || stored.revision !== where.revision) return { count: 0 };
        stored = { ...stored, ...data, revision: stored.revision + 1 };
        return { count: 1 };
      }),
    },
    globalParameter: {
      findMany: jest.fn(async ({ where }) =>
        [...parameters.values()].filter((p) => where.key.in.includes(p.key)),
      ),
      upsert: jest.fn(async ({ where, create, update }) => {
        if (failPricing) throw new Error('Simulated storage failure');
        const row = parameters.has(where.key)
          ? { ...parameters.get(where.key), ...update }
          : create;
        parameters.set(where.key, row);
        return row;
      }),
    },
    eventLog: { create: jest.fn(async ({ data }) => data) },
  };
  db.$transaction = async (run: (tx: any) => Promise<unknown>) => {
    const before = stored && { ...stored };
    const oldParameters = new Map(parameters);
    try {
      return await run(db);
    } catch (error) {
      stored = before;
      parameters = oldParameters;
      throw error;
    }
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WarehouseDeliveryController],
      providers: [
        WarehouseDeliveryService,
        { provide: PrismaService, useValue: db },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req, _res, next) => {
      const role = req.headers['x-test-role'];
      if (role) req.user = { id: 1, role: { name: role } };
      next();
    });
    app.useGlobalGuards(
      {
        canActivate(context) {
          if (!context.switchToHttp().getRequest().user)
            throw new UnauthorizedException();
          return true;
        },
      },
      new RolesGuard(new Reflector()),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    stored = null;
    failPricing = false;
    parameters = new Map([
      [
        'DELIVERY_BASE_PRICE',
        {
          id: 11,
          key: 'DELIVERY_BASE_PRICE',
          value: new Prisma.Decimal('600.1250'),
        },
      ],
      [
        'DELIVERY_INCLUDED_MILES',
        {
          id: 12,
          key: 'DELIVERY_INCLUDED_MILES',
          value: new Prisma.Decimal(60),
        },
      ],
      [
        'DELIVERY_ADDITIONAL_MILE_PRICE',
        {
          id: 13,
          key: 'DELIVERY_ADDITIONAL_MILE_PRICE',
          value: new Prisma.Decimal(5),
        },
      ],
    ]);
    jest.clearAllMocks();
  });
  const save = (body = valid(), role = 'admin') =>
    request(app.getHttpServer())
      .put('/warehouse-delivery')
      .set('x-test-role', role)
      .send(body);

  it('loads existing pricing without inserting or overwriting configuration', async () => {
    const res = await request(app.getHttpServer())
      .get('/warehouse-delivery')
      .set('x-test-role', 'admin')
      .expect(200);
    expect(res.body).toEqual({
      configuration: null,
      pricing: {
        basePrice: '600.125',
        includedMiles: '60',
        additionalMilePrice: '5',
      },
    });
    expect(db.globalParameter.upsert).not.toHaveBeenCalled();
    expect(db.warehouseDeliverySettings.create).not.toHaveBeenCalled();
  });

  it('saves the address and existing price rows together, keeping four-decimal precision', async () => {
    const res = await save({
      ...valid(),
      basePrice: 600.1234,
      additionalMilePrice: 0,
    }).expect(200);
    expect(res.body.configuration).toMatchObject({
      street: '100 Warehouse Road',
      city: 'Miami',
      state: 'FL',
      revision: 1,
    });
    expect(res.body.pricing).toEqual({
      basePrice: '600.1234',
      includedMiles: '60',
      additionalMilePrice: '0',
    });
    expect(parameters.size).toBe(3);
    expect(parameters.get('DELIVERY_BASE_PRICE').id).toBe(11);
    expect(db.eventLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects outdated revisions before changing the prices', async () => {
    await save().expect(200);
    await save({ ...valid(), revision: 1, basePrice: 700 }).expect(200);
    await save({ ...valid(), revision: 1, basePrice: 900 }).expect(409);
    expect(stored.revision).toBe(2);
    expect(parameters.get('DELIVERY_BASE_PRICE').value.toString()).toBe('700');
    await save().expect(409);
  });

  it('does not leave a changed address when saving the pricing fails', async () => {
    await save().expect(200);
    failPricing = true;
    const service = app.get(WarehouseDeliveryService);
    await expect(
      service.save({ ...valid(), revision: 1, street: 'Other warehouse' }, 1),
    ).rejects.toThrow('storage failure');
    expect(stored.street).toBe('100 Warehouse Road');
    expect(stored.revision).toBe(1);
  });

  it.each(['client', 'dealer', 'operator'])(
    'blocks %s from reading or editing configuration',
    async (role) => {
      await request(app.getHttpServer())
        .get('/warehouse-delivery')
        .set('x-test-role', role)
        .expect(403);
      await save(valid(), role).expect(403);
      expect(db.globalParameter.upsert).not.toHaveBeenCalled();
    },
  );

  it('requires authentication and exposes only the pickup address to customers', async () => {
    await request(app.getHttpServer())
      .get('/warehouse-delivery/pickup-address')
      .expect(401);
    await save().expect(200);
    for (const role of ['client', 'dealer', 'operator']) {
      const res = await request(app.getHttpServer())
        .get('/warehouse-delivery/pickup-address')
        .set('x-test-role', role)
        .expect(200);
      expect(res.body).toEqual({
        address: {
          street: '100 Warehouse Road',
          city: 'Miami',
          state: 'FL',
          postalCode: '33101',
        },
      });
    }
  });

  it.each([
    ['maxDeliveryMiles', 0],
    ['maxDeliveryMiles', null],
    ['maxDeliveryMiles', true],
    ['maxDeliveryMiles', ''],
    ['maxDeliveryMiles', 150.001],
    ['includedMiles', 151],
    ['basePrice', 0],
    ['basePrice', 1000000],
    ['additionalMilePrice', -1],
    ['street', '   '],
    ['state', 'XX'],
    ['postalCode', '123'],
  ])('rejects invalid %s = %s before writing', async (key, value) => {
    await save({ ...valid(), [key]: value } as any).expect(400);
    expect(db.warehouseDeliverySettings.create).not.toHaveBeenCalled();
    expect(db.globalParameter.upsert).not.toHaveBeenCalled();
  });

  it('prevents old Global Parameters endpoints from bypassing the shared settings revision', async () => {
    const service = new GlobalParametersService(db);
    for (const key of DELIVERY_PARAMETER_KEYS) {
      await expect(
        service.update(key as GlobalParameterKey, { value: 20 } as any),
      ).rejects.toThrow('Warehouse & Delivery');
    }
    expect(db.globalParameter.upsert).not.toHaveBeenCalled();
  });
});

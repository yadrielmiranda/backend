import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { InstallationCoverageController } from './installation-coverage.controller';
import { InstallationCoverageService } from './installation-coverage.service';

const valid = () => ({
  revision: 0,
  originStreet: ' 100 Example Street ',
  originCity: ' Miami ',
  originState: 'fl',
  originPostalCode: '33101',
  includedMiles: 25,
  maxDistanceMiles: 75,
  ranges: [
    { upToMiles: 50, chargeType: 'FIXED', value: 150 },
    { upToMiles: 75, chargeType: 'PERCENTAGE', value: 15 },
  ],
});

// HTTP, DTO, permisos y servicio reales; la base se sustituye por almacenamiento aislado.
describe('Installation coverage settings', () => {
  let app: INestApplication;
  let stored: any = null;
  let events: any[] = [];
  const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
  const eventLog = {
    create: jest.fn(async ({ data }) => {
      events.push(clone(data));
      return data;
    }),
  };
  const db: any = {
    installationCoverage: {
      findUnique: jest.fn(async () => stored && clone(stored)),
      findUniqueOrThrow: jest.fn(async () => clone(stored)),
      create: jest.fn(async ({ data }) => {
        if (stored)
          throw new Prisma.PrismaClientKnownRequestError('Already configured', {
            code: 'P2002',
            clientVersion: '6.18.0',
          });
        stored = clone({
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return clone(stored);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!stored || stored.revision !== where.revision) return { count: 0 };
        stored = clone({
          ...stored,
          ...data,
          revision: stored.revision + 1,
          updatedAt: new Date(),
        });
        return { count: 1 };
      }),
    },
    eventLog,
  };
  let queue = Promise.resolve();
  db.$transaction = (run: (tx: any) => Promise<unknown>) => {
    const work = queue.then(async () => {
      const before = clone(stored);
      const priorEvents = clone(events);
      try {
        return await run(db);
      } catch (error) {
        stored = before;
        events = priorEvents;
        throw error;
      }
    });
    queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InstallationCoverageController],
      providers: [
        InstallationCoverageService,
        { provide: PrismaService, useValue: db },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalGuards(
      {
        canActivate(context) {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) throw new UnauthorizedException();
          req.user = { id: 7, role: { name: req.headers['x-test-role'] } };
          return true;
        },
      },
      new RolesGuard(module.get(Reflector)),
    );
    app.useLogger(false);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    stored = null;
    events = [];
    jest.clearAllMocks();
  });
  const read = (role = 'admin') =>
    request(app.getHttpServer())
      .get('/api/installation-coverage')
      .set('x-test-role', role);
  const save = (payload: object, role = 'admin') =>
    request(app.getHttpServer())
      .put('/api/installation-coverage')
      .set('x-test-role', role)
      .send(payload);

  it('starts unconfigured without creating a policy on GET', async () => {
    expect((await read().expect(200)).body).toEqual({ configuration: null });
    expect(db.installationCoverage.create).not.toHaveBeenCalled();
  });

  it('saves and reloads mixed charge types, exact amounts, the address and the boundaries', async () => {
    const saved = (await save(valid()).expect(200)).body;
    expect(saved).toMatchObject({
      revision: 1,
      originStreet: '100 Example Street',
      originCity: 'Miami',
      originState: 'FL',
      includedMiles: '25',
      maxDistanceMiles: '75',
    });
    expect(saved.ranges).toEqual([
      {
        fromMiles: '25.00',
        upToMiles: '50.00',
        chargeType: 'FIXED',
        value: '150.00',
      },
      {
        fromMiles: '50.00',
        upToMiles: '75.00',
        chargeType: 'PERCENTAGE',
        value: '15.00',
      },
    ]);
    expect((await read().expect(200)).body.configuration).toEqual(saved);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        userId: 7,
        entityType: 'InstallationCoverage',
      }),
    ]);
  });

  it('edits the policy atomically and allows removing all paid ranges', async () => {
    await save(valid()).expect(200);
    const saved = (
      await save({
        ...valid(),
        revision: 1,
        includedMiles: 100,
        maxDistanceMiles: 100,
        ranges: [],
      }).expect(200)
    ).body;
    expect(saved).toMatchObject({
      revision: 2,
      includedMiles: '100',
      maxDistanceMiles: '100',
      ranges: [],
    });
    expect(events.at(-1).action).toBe('UPDATE');
  });

  it('accepts zero included miles, zero charges, decimal boundaries and percentages above 100', async () => {
    const saved = (
      await save({
        ...valid(),
        includedMiles: 0,
        maxDistanceMiles: 75.25,
        ranges: [
          { upToMiles: 40.5, chargeType: 'FIXED', value: 0 },
          { upToMiles: 75.25, chargeType: 'PERCENTAGE', value: 125.5 },
        ],
      }).expect(200)
    ).body;
    expect(saved.ranges[1]).toEqual({
      fromMiles: '40.50',
      upToMiles: '75.25',
      chargeType: 'PERCENTAGE',
      value: '125.50',
    });
  });

  it.each(['operator', 'dealer', 'client'])(
    'blocks reading and writing for %s',
    async (role) => {
      await read(role).expect(403);
      await save(valid(), role).expect(403);
      expect(stored).toBeNull();
    },
  );

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/installation-coverage')
      .expect(401);
    await request(app.getHttpServer())
      .put('/api/installation-coverage')
      .send(valid())
      .expect(401);
  });

  it.each([
    ['empty address', { originStreet: '  ' }],
    ['invalid state', { originState: 'ZZ' }],
    ['invalid ZIP', { originPostalCode: 'abc' }],
    ['missing distance', { maxDistanceMiles: null }],
    ['boolean distance', { maxDistanceMiles: true }],
    ['empty included miles', { includedMiles: '' }],
    ['negative included miles', { includedMiles: -1 }],
    ['excess precision', { includedMiles: 25.001 }],
    ['included miles beyond maximum', { includedMiles: 100 }],
    ['missing ranges', { ranges: null }],
    ['uncovered distance', { ranges: [] }],
    [
      'overlapping ranges',
      { ranges: [{ upToMiles: 25, chargeType: 'FIXED', value: 1 }] },
    ],
    [
      'range beyond maximum',
      { ranges: [{ upToMiles: 80, chargeType: 'FIXED', value: 1 }] },
    ],
    [
      'negative charge',
      { ranges: [{ upToMiles: 75, chargeType: 'FIXED', value: -1 }] },
    ],
    [
      'empty charge',
      { ranges: [{ upToMiles: 75, chargeType: 'FIXED', value: null }] },
    ],
    [
      'unsupported charge type',
      { ranges: [{ upToMiles: 75, chargeType: 'PER_MILE', value: 1 }] },
    ],
    [
      'too many ranges',
      {
        ranges: Array.from({ length: 31 }, (_, index) => ({
          upToMiles: 26 + index,
          chargeType: 'FIXED',
          value: 1,
        })),
      },
    ],
  ])('rejects %s without altering saved settings', async (_, patch) => {
    await save(valid()).expect(200);
    const before = clone(stored);
    await save({ ...valid(), revision: 1, ...patch }).expect(400);
    expect(stored).toEqual(before);
    expect(events).toHaveLength(1);
  });

  it('rejects stale edits and competing initial saves', async () => {
    await save(valid()).expect(200);
    await save(valid()).expect(409);
    const responses = await Promise.all([
      save({ ...valid(), revision: 1, originCity: 'Miami Beach' }),
      save({ ...valid(), revision: 1, originCity: 'Doral' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(stored.revision).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('rolls back the settings if the audit record cannot be saved', async () => {
    await save(valid()).expect(200);
    const before = clone(stored);
    eventLog.create.mockRejectedValueOnce(new Error('Storage unavailable'));
    await save({ ...valid(), revision: 1, originCity: 'Doral' }).expect(500);
    expect(stored).toEqual(before);
    expect(events).toHaveLength(1);
  });
});

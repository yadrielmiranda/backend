import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { ResponsePrivacyInterceptor } from '@/common/response-privacy.interceptor';
import { LogsService } from '@/logs/logs.service';
import { PrismaService } from '@/prisma/prisma.service';
import { InstallationCatalogController } from './installation-catalog.controller';
import { InstallationCatalogService } from './installation-catalog.service';

const valid = () => ({
  name: 'Window installation',
  billingUnit: 'UNIT',
  ruleMetric: 'WIDTH',
  baseRate: 100,
  minimumCharge: 200,
  estimatedMinutes: 30.5,
  rules: [
    {
      minValue: null,
      maxValue: 48,
      minInclusive: true,
      maxInclusive: false,
      rate: 100,
      estimatedMinutes: null,
    },
    {
      minValue: 48,
      maxValue: null,
      minInclusive: true,
      maxInclusive: false,
      rate: 150,
      estimatedMinutes: 60,
    },
  ],
});

// Se prueban el controlador, DTO, permisos y catálogo reales con almacenamiento aislado.
describe('Installation service time settings', () => {
  let app: INestApplication;
  let stored: any = null;
  let nextRuleId = 1;
  const copy = (value: unknown) => JSON.parse(JSON.stringify(value));
  const makeRules = (rules: any[]) =>
    rules.map((rule) => ({
      ...copy(rule),
      id: nextRuleId++,
      serviceId: 1,
      createdAt: '2026-09-18T22:00:00.000Z',
      updatedAt: '2026-09-18T22:00:00.000Z',
    }));
  const logs = { log: jest.fn().mockResolvedValue(undefined) };
  const db: any = {
    installationService: {
      findMany: jest.fn(async () => (stored ? [copy(stored)] : [])),
      findUnique: jest.fn(async () => (stored ? copy(stored) : null)),
      create: jest.fn(async ({ data }) => {
        const { rules, ...fields } = data;
        stored = {
          ...copy(fields),
          id: 1,
          rules: makeRules(rules.create),
          _count: { sysConfs: 0, lines: 0 },
          createdAt: '2026-09-18T22:00:00.000Z',
          updatedAt: '2026-09-18T22:00:00.000Z',
        };
        return copy(stored);
      }),
      update: jest.fn(async ({ data }) => {
        const { rules, ...fields } = data;
        stored = {
          ...stored,
          ...copy(fields),
          ...(rules ? { rules: makeRules(rules.create) } : {}),
        };
        return copy(stored);
      }),
    },
    installationServiceRule: {
      deleteMany: jest.fn(async () => {
        stored.rules = [];
      }),
      updateMany: jest.fn(async ({ data }) => {
        stored.rules = stored.rules.map((rule: any) => ({
          ...rule,
          ...copy(data),
        }));
        return { count: stored.rules.length };
      }),
    },
    sysConf: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: async (run: (tx: any) => Promise<unknown>) => {
      const before = copy(stored);
      try {
        return await run(db);
      } catch (error) {
        stored = before;
        throw error;
      }
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InstallationCatalogController],
      providers: [
        InstallationCatalogService,
        { provide: PrismaService, useValue: db },
        { provide: LogsService, useValue: logs },
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
    app.useGlobalInterceptors(new ResponsePrivacyInterceptor());
    app.useLogger(false);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    stored = null;
    nextRuleId = 1;
    jest.clearAllMocks();
  });
  const create = (body: object, role = 'admin') =>
    request(app.getHttpServer())
      .post('/api/installation-services')
      .set('x-test-role', role)
      .send(body);
  const edit = (body: object, role = 'admin') =>
    request(app.getHttpServer())
      .patch('/api/installation-services/1')
      .set('x-test-role', role)
      .send(body);
  const read = (role = 'admin') =>
    request(app.getHttpServer())
      .get('/api/installation-services/1')
      .set('x-test-role', role);

  it.each([undefined, null])('defaults missing base time %j to zero while ranges inherit it', async (estimatedMinutes) => {
    const payload = valid();
    payload.estimatedMinutes = estimatedMinutes;
    payload.rules.forEach((rule) => {
      delete rule.estimatedMinutes;
    });
    const saved = (await create(payload).expect(201)).body;
    expect(saved.estimatedMinutes).toBe('0');
    expect(saved.rules.map((rule) => rule.estimatedMinutes)).toEqual([
      null,
      null,
    ]);
    expect((await read().expect(200)).body).toEqual(saved);
  });

  it('stores base time, inheritance and explicit zero independently from prices', async () => {
    const payload = valid();
    payload.rules[1].estimatedMinutes = 0;
    const saved = (await create(payload).expect(201)).body;
    expect(saved).toMatchObject({
      estimatedMinutes: '30.5',
      baseRate: '100',
      minimumCharge: '200',
    });
    expect(saved.rules.map((rule) => rule.estimatedMinutes)).toEqual([
      null,
      '0',
    ]);
    expect(saved.rules.map((rule) => rule.rate)).toEqual(['100', '150']);
    expect((await read().expect(200)).body).toEqual(saved);
  });

  it('retains stored times and rule identities when an unrelated field changes', async () => {
    const before = (await create(valid()).expect(201)).body;
    const saved = (
      await edit({ description: 'Updated description', baseRate: 110 }).expect(
        200,
      )
    ).body;
    expect(saved.estimatedMinutes).toBe(before.estimatedMinutes);
    expect(saved.rules).toEqual(before.rules);
    expect(db.installationServiceRule.deleteMany).not.toHaveBeenCalled();
  });

  it('saves an entered base time and resets null to zero without overwriting range overrides', async () => {
    const initial = (await create(valid()).expect(201)).body;
    const updated = (await edit({ estimatedMinutes: 20 }).expect(200)).body;
    expect(updated.estimatedMinutes).toBe('20');
    expect(updated.rules).toEqual(initial.rules);
    const reset = (await edit({ estimatedMinutes: null }).expect(200)).body;
    expect(reset.estimatedMinutes).toBe('0');
    expect(reset.rules).toEqual(initial.rules);
    expect(reset.baseRate).toBe(initial.baseRate);
  });

  it('can restore a range to inherited time and explicitly configure another as zero', async () => {
    await create(valid()).expect(201);
    const rules = valid().rules;
    rules[0].estimatedMinutes = 0;
    rules[1].estimatedMinutes = null;
    const saved = (await edit({ rules }).expect(200)).body;
    expect(saved.rules.map((rule) => rule.estimatedMinutes)).toEqual([
      '0',
      null,
    ]);
    expect(saved.estimatedMinutes).toBe('30.5');
    expect(saved.rules.map((rule) => rule.rate)).toEqual(['100', '150']);
  });

  it.each(['UNIT', 'PANEL', 'SQFT', 'SQFT_RECTANGULAR', 'LINEAR_FOOT'])(
    'accepts fractional minutes with the existing %s unit',
    async (billingUnit) => {
      const saved = (
        await create({
          ...valid(),
          billingUnit,
          ruleMetric: 'NONE',
          rules: [],
          estimatedMinutes: '0.0125',
        }).expect(201)
      ).body;
      expect(saved.estimatedMinutes).toBe('0.0125');
      expect(saved.billingUnit).toBe(billingUnit);
    },
  );

  it.each([-1, true, '', [], {}, 'NaN', 0.00001, 100000000])(
    'rejects invalid base and range time %j without altering saved settings',
    async (estimatedMinutes) => {
      await create(valid()).expect(201);
      const before = copy(stored);
      await edit({ estimatedMinutes }).expect(400);
      await edit({
        rules: valid().rules.map((rule) => ({ ...rule, estimatedMinutes })),
      }).expect(400);
      expect(stored).toEqual(before);
      expect(logs.log).toHaveBeenCalledTimes(1);
    },
  );

  it('resets the base to zero and clears overrides when billing formula changes without replacement times', async () => {
    const original = (await create(valid()).expect(201)).body;
    const saved = (await edit({ billingUnit: 'SQFT' }).expect(200)).body;
    expect(saved.estimatedMinutes).toBe('0');
    expect(saved.rules.map((rule) => rule.estimatedMinutes)).toEqual([
      null,
      null,
    ]);
    expect(saved.rules.map((rule) => rule.rate)).toEqual(
      original.rules.map((rule) => rule.rate),
    );
    expect(saved.rules.map((rule) => rule.id)).toEqual(
      original.rules.map((rule) => rule.id),
    );
  });

  it('accepts explicitly entered times for a new billing unit', async () => {
    await create(valid()).expect(201);
    const saved = (
      await edit({
        billingUnit: 'SQFT',
        estimatedMinutes: 0.5,
        rules: valid().rules.map((rule) => ({
          ...rule,
          estimatedMinutes: 0.75,
        })),
      }).expect(200)
    ).body;
    expect(saved.estimatedMinutes).toBe('0.5');
    expect(saved.rules.map((rule) => rule.estimatedMinutes)).toEqual([
      '0.75',
      '0.75',
    ]);
  });

  it.each(['client', 'dealer', 'operator'])(
    'prevents %s from editing or reading internal times',
    async (role) => {
      await create(valid()).expect(201);
      const before = copy(stored);
      await create(valid(), role).expect(403);
      await edit({ estimatedMinutes: 0 }, role).expect(403);
      const response = (await read(role).expect(200)).body;
      expect(response).not.toHaveProperty('estimatedMinutes');
      expect(response).not.toHaveProperty('rules');
      expect(stored).toEqual(before);
    },
  );

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/installation-services')
      .send(valid())
      .expect(401);
    expect(stored).toBeNull();
  });
});

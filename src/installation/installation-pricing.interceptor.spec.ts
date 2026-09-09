import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import type { AuthUser, RoleName } from '@/auth/types/auth-user.type';
import { InstallationCatalogController } from './installation-catalog.controller';
import { InstallationCatalogService } from './installation-catalog.service';
import { InstallationWorkflowController } from './installation-workflow.controller';
import { InstallationWorkflowService } from './installation-workflow.service';
import { presentInstallationPricing } from './installation-pricing.interceptor';

const user = (name: RoleName): AuthUser => ({ id: 7, role: { name } });
const decimal = (value: string) => new Prisma.Decimal(value);
const service = {
  id: 8,
  name: 'Store Front',
  billingUnit: 'SQFT',
  ruleMetric: 'AREA',
  baseRate: decimal('35'),
  minimumCharge: decimal('100'),
  availableForRequest: true,
  availableForField: true,
  isActive: true,
  sortOrder: 0,
  rules: [{ id: 1, rate: decimal('35'), minValue: null, maxValue: null }],
};
const line = {
  id: 10,
  quoteId: 1,
  serviceId: 8,
  measurementId: 5,
  origin: 'AUTO',
  serviceNameSnapshot: 'Store Front',
  componentLabel: 'Wall O',
  billingUnitSnapshot: 'SQFT',
  ruleMetricSnapshot: 'AREA',
  ruleSnapshot: { rate: '35', minimumCharge: '100' },
  metricValue: decimal('20'),
  widthIn: decimal('48'),
  heightIn: decimal('60'),
  areaSqFt: decimal('20'),
  rate: decimal('35'),
  billableQuantity: decimal('20'),
  occurrences: 1,
  baseAmount: decimal('700'),
  adjustmentPercent: decimal('0'),
  adjustedAmount: decimal('700'),
  sortOrder: 0,
};
const quote = {
  id: 1,
  jobId: 64,
  version: 2,
  status: 'APPROVED',
  approvalReason: 'REMEASUREMENT',
  profileId: 3,
  profileNameSnapshot: 'Client Installation',
  profileAdjustmentPercent: decimal('0'),
  profileMinimumSnapshot: decimal('100'),
  baseSubtotal: decimal('700'),
  adjustedSubtotal: decimal('700'),
  serviceMinimumAdjustment: decimal('0'),
  serviceMinimumsSnapshot: [],
  minimumAdjustment: decimal('0'),
  total: decimal('700'),
  needsRecalculation: false,
  lines: [line],
  approvals: [],
  createdAt: new Date('2026-09-09T12:00:00Z'),
};
const job = {
  id: 64,
  status: 'APPROVED',
  quotes: [quote, { ...quote, id: 2, version: 1 }],
  estimate: {
    id: 66,
    rateT: decimal('500'),
    priceT: decimal('900'),
    user: {
      id: 7,
      password: 'test-only-secret',
      installationPriceProfileId: 3,
    },
    pieces: [
      {
        id: 1,
        rate: decimal('35'),
        price: decimal('70'),
        netProfit: decimal('35'),
      },
    ],
  },
  measurements: [
    {
      id: 5,
      widthIn: decimal('48'),
      heightIn: decimal('60'),
      sourceSnapshot: { rate: '35', markup: '100', price: '70' },
    },
  ],
  payments: [{ id: 4, amount: decimal('100') }],
};

function expectCommercial(result: any) {
  for (const current of result.quotes) {
    expect(current).toMatchObject({
      pricingDetailsVisible: false,
      total: decimal('700'),
    });
    expect(current).not.toHaveProperty('profileNameSnapshot');
    expect(current).not.toHaveProperty('baseSubtotal');
    expect(current.lines[0]).toMatchObject({
      unitPrice: '700.000000',
      occurrences: 1,
    });
    for (const key of [
      'rate',
      'origin',
      'billableQuantity',
      'ruleSnapshot',
      'metricValue',
      'billingUnitSnapshot',
      'adjustmentPercent',
      'baseAmount',
    ]) {
      expect(current.lines[0]).not.toHaveProperty(key);
    }
  }
}

describe('installation pricing response privacy', () => {
  it.each<RoleName>(['client', 'dealer', 'operator'])(
    'protects every quote version for %s and preserves commercial amounts',
    (role) => {
      const result = presentInstallationPricing(job, user(role));
      expectCommercial(result);
      expect(result.estimate).not.toHaveProperty('rateT');
      expect(result.estimate.pieces[0]).toEqual({
        id: 1,
        price: decimal('70'),
      });
      expect(result.measurements[0]).toMatchObject({
        widthIn: decimal('48'),
        heightIn: decimal('60'),
      });
      expect(result.measurements[0].sourceSnapshot).toEqual({ price: '70' });
      expect(result.payments).toEqual(job.payments);
      expect(result.quotes[0].createdAt).toBe(quote.createdAt);
      expect(result.estimate.user).toEqual({ id: 7 });
    },
  );

  it('does not expose internal pricing when the role is absent', () => {
    expectCommercial(presentInstallationPricing(job));
  });

  it('retains admin pricing without mutating the source or returning credentials', () => {
    const before = JSON.stringify(job);
    presentInstallationPricing(job, user('client'));
    const result = presentInstallationPricing(job, user('admin'));
    expect(result.quotes[0]).toMatchObject({
      ...quote,
      pricingDetailsVisible: true,
    });
    expect(result.estimate.rateT).toEqual(decimal('500'));
    expect(result.estimate.user).not.toHaveProperty('password');
    expect(JSON.stringify(job)).toBe(before);
  });

  it('uses the final line amount for unit prices and preserves minimum charges', () => {
    const result = presentInstallationPricing(
      {
        ...quote,
        total: decimal('190'),
        profileAdjustmentPercent: decimal('-10'),
        lines: [
          {
            ...line,
            occurrences: 3,
            baseAmount: decimal('180'),
            adjustedAmount: decimal('162'),
          },
        ],
      },
      user('client'),
    );
    expect(result.lines[0].unitPrice).toBe('54.000000');
    expect(result.additionalInstallationCharge).toBe('28.00');
    expect(
      Number(result.lines[0].unitPrice) * result.lines[0].occurrences +
        Number(result.additionalInstallationCharge),
    ).toBe(Number(result.total));
  });

  it('preserves requested dimensions, removability and additional-service totals', () => {
    const draft = {
      ...quote,
      status: 'DRAFT',
      total: decimal('810'),
      serviceMinimumsSnapshot: [
        { serviceId: 9, adjustment: '10', minimumCharge: '110' },
      ],
      lines: [
        line,
        {
          ...line,
          id: 11,
          serviceId: 9,
          origin: 'USER_SELECTED',
          serviceNameSnapshot: 'Concrete cutting',
          adjustedAmount: decimal('100'),
        },
      ],
    };
    const result = presentInstallationPricing(draft, user('client'));
    expect(result.lines[0]).toMatchObject({
      isRequestedService: false,
      canRemove: false,
    });
    expect(result.lines[1]).toMatchObject({
      isRequestedService: true,
      canRemove: true,
      widthIn: decimal('48'),
      heightIn: decimal('60'),
      areaSqFt: decimal('20'),
    });
    expect(result.additionalServices).toEqual([
      { serviceId: 9, name: 'Concrete cutting', amount: '110.00' },
    ]);
    const fieldDraft = {
      ...draft,
      lines: [{ ...line, origin: 'FIELD_ADDED' }],
    };
    expect(
      presentInstallationPricing(fieldDraft, user('client')).lines[0].canRemove,
    ).toBe(false);
    expect(
      presentInstallationPricing(fieldDraft, user('operator')).lines[0]
        .canRemove,
    ).toBe(true);
    expect(
      presentInstallationPricing(
        { ...draft, status: 'APPROVED' },
        user('client'),
      ).lines[1].canRemove,
    ).toBe(false);
  });

  it('protects catalog prices including nested mappings, retaining service input requirements', () => {
    const result = presentInstallationPricing(
      { service, mappings: [{ service }] },
      user('operator'),
    );
    for (const item of [result.service, result.mappings[0].service]) {
      expect(item).toMatchObject({
        id: 8,
        billingUnit: 'SQFT',
        ruleMetric: 'AREA',
        availableForRequest: true,
      });
      expect(item).not.toHaveProperty('baseRate');
      expect(item).not.toHaveProperty('rules');
      expect(item).not.toHaveProperty('minimumCharge');
    }
    expect(presentInstallationPricing(service, user('admin'))).toEqual(service);
  });
});

describe('installation pricing HTTP boundaries', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        InstallationWorkflowController,
        InstallationCatalogController,
      ],
      providers: [
        {
          provide: InstallationWorkflowService,
          useValue: {
            findJobs: () => ({ data: [job], total: 1 }),
            findJob: () => job,
            findJobByEstimate: () => job,
            rebuildQuote: () => job,
          },
        },
        {
          provide: InstallationCatalogService,
          useValue: {
            findServices: () => [service],
            findService: () => service,
            findProfiles: () => [{ id: 3, name: 'Client Installation' }],
            findProfile: () => ({ id: 3, name: 'Client Installation' }),
          },
        },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    // Simula la identidad ya autenticada; utiliza el guard de roles y los controladores reales.
    app.use((req: any, _res: any, next: () => void) => {
      req.user = user(req.headers['x-test-role'] as RoleName);
      next();
    });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['installations/64', 'estimates/66/installation'])(
    'filters the actual %s endpoint for the authenticated role',
    async (path) => {
      const response = await request(app.getHttpServer())
        .get(`/${path}`)
        .set('x-test-role', 'client')
        .expect(200);
      expect(response.body.quotes[0].lines[0].unitPrice).toBe('700.000000');
      expect(response.body.quotes[0]).not.toHaveProperty('profileNameSnapshot');
      const admin = await request(app.getHttpServer())
        .get(`/${path}`)
        .set('x-test-role', 'admin')
        .expect(200);
      expect(admin.body.quotes[0]).toMatchObject({
        pricingDetailsVisible: true,
        profileNameSnapshot: 'Client Installation',
      });
    },
  );

  it('also filters paginated lists and operator mutation responses', async () => {
    const list = await request(app.getHttpServer())
      .get('/installations')
      .set('x-test-role', 'dealer')
      .expect(200);
    expect(list.body.data[0].quotes[0].lines[0]).not.toHaveProperty('rate');
    const rebuilt = await request(app.getHttpServer())
      .post('/installations/64/rebuild')
      .set('x-test-role', 'operator')
      .expect(201);
    expect(rebuilt.body.quotes[0].lines[0]).not.toHaveProperty('rate');
    expect(rebuilt.body.quotes[0].lines[0].unitPrice).toBe('700.000000');
  });

  it.each<RoleName>(['client', 'dealer', 'operator'])(
    'protects direct catalog access and price profiles for %s',
    async (role) => {
      const catalog = await request(app.getHttpServer())
        .get('/installation-services')
        .set('x-test-role', role)
        .expect(200);
      expect(catalog.body[0]).not.toHaveProperty('baseRate');
      const single = await request(app.getHttpServer())
        .get('/installation-services/8')
        .set('x-test-role', role)
        .expect(200);
      expect(single.body).not.toHaveProperty('rules');
      for (const path of [
        '/installation-price-profiles',
        '/installation-price-profiles/3',
      ]) {
        await request(app.getHttpServer())
          .get(path)
          .set('x-test-role', role)
          .expect(403);
        await request(app.getHttpServer())
          .get(path)
          .set('x-test-role', 'admin')
          .expect(200);
      }
    },
  );
});

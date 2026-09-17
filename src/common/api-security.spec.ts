import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtStrategy } from '@/auth/guards/auth/jwt.strategy';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { SessionTouchGuard } from '@/auth/guards/auth/session-touch.guard';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { AuthController } from '@/auth/auth.controller';
import { AuthService } from '@/auth/auth.service';
import { UsersService } from '@/users/users.service';
import { EstimatesController } from '@/estimates/estimates.controller';
import { EstimatesService } from '@/estimates/estimates.service';
import { EstimatePublicShareService } from '@/estimates/public-share/estimate-public-share.service';
import { EstimateCustomerChargesService } from '@/estimates/estimate-customer-charges.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import { OrdersController } from '@/orders/orders.controller';
import { OrdersService } from '@/orders/orders.service';
import { ConfigCategoriesController } from '@/config-categories/config-categories.controller';
import { ConfigCategoriesService } from '@/config-categories/config-categories.service';
import { LinearPricingRulesController } from '@/linear-pricing-rules/linear-pricing-rules.controller';
import { LinearPricingRulesService } from '@/linear-pricing-rules/linear-pricing-rules.service';
import { ResponsePrivacyInterceptor, presentApiResponse } from './response-privacy.interceptor';

const secret = 'http-security-test-secret';
const signer = new JwtService({ secret });
const roles = ['client', 'dealer', 'operator', 'admin'] as const;
const version = new Date('2026-01-01T12:00:00.123Z');
const piece = { id: 4, idProd: 1, qty: 2, price: new Prisma.Decimal('119.32'),
  customerPrice: new Prisma.Decimal('149.15'), subtotal: new Prisma.Decimal('238.64'),
  customerSubtotal: new Prisma.Decimal('298.30'), rate: new Prisma.Decimal('100'),
  netProfit: new Prisma.Decimal('19.32'), markup: new Prisma.Decimal('.1932'),
  dealerMarkup: new Prisma.Decimal('.25'), netProfitD: new Prisma.Decimal('59.66'),
  activeOption: { id: 1, name: 'Option', costoA: new Prisma.Decimal('17'), costoB: 2, costoC: 3 } };
const raw = { id: 1, number: '190943', date: version, rateT: new Prisma.Decimal('200'),
  netProfit: new Prisma.Decimal('38.64'), netProfitD: new Prisma.Decimal('59.66'),
  priceT: new Prisma.Decimal('238.64'), customerPriceT: new Prisma.Decimal('298.30'),
  taxAmount: new Prisma.Decimal('16.70'), ownerMarkupSnapshot: '.1932', pieces: [piece],
  user: { id: 7, idRole: 4, username: 'owner', email: 'owner@example.test', password: 'sensitive-hash',
    role: { name: 'dealer', markup: '.1932' }, sessions: [{ refreshTokenHash: 'secret' }] },
  paymentSchedule: { balance: '500.00', canRelease: true, canInstall: true },
};

describe('Real HTTP authorization and response boundaries (H01–H04)', () => {
  let app: INestApplication;
  let accounts: Map<string, any>;
  let sessions: Map<string, any>;
  let categories: any;
  let estimates: any;
  let users: any;
  const sid = (role: string) => `10000000-0000-4000-8000-${String(roles.indexOf(role as any) + 1).padStart(12, '0')}`;
  const cookie = (role: string, extra = {}) => `access_token=${signer.sign({
    sub: roles.indexOf(role as any) + 7, sid: sid(role), role, tokenType: 'access', passwordVersion: version.getTime(), ...extra,
  }, { expiresIn: '15m' })}`;

  beforeAll(async () => {
    accounts = new Map(roles.map((role, index) => [role, { id: index + 7, username: role,
      isActive: true, deletedAt: null, passwordUpdatedAt: version, role: { name: role } }]));
    sessions = new Map(roles.map(role => [sid(role), { id: sid(role), userId: accounts.get(role).id,
      user: accounts.get(role), revokedAt: null, expiresAt: new Date(Date.now() + 86400000), lastUsedAt: new Date() }]));
    const db: any = { session: {
      findUnique: jest.fn(async ({ where }) => sessions.get(where.id)),
      updateMany: jest.fn(async ({ where }) => ({ count: sessions.get(where.id)?.revokedAt ? 0 : 1 })),
    } };
    users = { updateUser: jest.fn(async ({ data }) => data), userSafe: jest.fn(async () => raw.user) };
    const auth = new AuthService(users, db, signer, {} as any, {} as any, {} as any);
    categories = { findAll: jest.fn(async () => [{ id: 1, name: 'Windows' }]),
      create: jest.fn(async () => ({ id: 2 })), update: jest.fn(async () => ({ id: 2 })), remove: jest.fn(async () => ({ id: 2 })) };
    estimates = { findAllForUser: jest.fn(async () => [raw]), findOneForUser: jest.fn(async () => raw),
      updateEstimateHeader: jest.fn(async () => raw), createEmptyEstimate: jest.fn(async () => raw) };
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AuthController, ConfigCategoriesController, LinearPricingRulesController, EstimatesController, OrdersController],
      providers: [JwtStrategy,
        { provide: ConfigService, useValue: { get: () => secret } }, { provide: PrismaService, useValue: db },
        { provide: AuthService, useValue: auth }, { provide: UsersService, useValue: users },
        { provide: ConfigCategoriesService, useValue: categories },
        { provide: LinearPricingRulesService, useValue: { findAll: async () => [{ id: 1, costPerInch: '1.25' }] } },
        { provide: EstimatesService, useValue: estimates }, { provide: EstimatePublicShareService, useValue: {} },
        { provide: InstallationWorkflowService, useValue: {} }, { provide: EstimateCustomerChargesService, useValue: {} },
        { provide: OrdersService, useValue: { findOneForUser: async () => ({ id: 10, idEst: 1, estimate: raw,
          rate: 200, rateReal: 190, netProfit: 38.64, netProfitReal: 48.64, poNumber: 'FACTORY-PRIVATE', user: raw.user }) } },
        { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: SessionTouchGuard },
        { provide: APP_INTERCEPTOR, useClass: ResponsePrivacyInterceptor },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api'); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('rejects unauthenticated requests and refresh-token substitution', async () => {
    await request(app.getHttpServer()).get('/api/estimates').expect(401);
    await request(app.getHttpServer()).get('/api/estimates').set('Cookie', cookie('client', { tokenType: 'refresh' })).expect(401);
  });

  it('rejects a revoked access-only session even if no refresh cookie is sent', async () => {
    sessions.get(sid('client')).revokedAt = new Date();
    try { await request(app.getHttpServer()).get('/api/estimates').set('Cookie', cookie('client')).expect(401); }
    finally { sessions.get(sid('client')).revokedAt = null; }
  });

  it('does not authorize an old admin claim after the account becomes client', async () => {
    accounts.get('admin').role.name = 'client';
    try { await request(app.getHttpServer()).post('/api/config-categories').set('Cookie', cookie('admin')).send({ name: 'New', idProduct: 1 }).expect(403); }
    finally { accounts.get('admin').role.name = 'admin'; }
  });

  it('the profile endpoint cannot change price, exemption, role, activation or password', async () => {
    await request(app.getHttpServer()).patch('/api/auth/profile').set('Cookie', cookie('client'))
      .send({ firstName: 'Updated', markupOverride: '-.99', isTaxExempt: true, idRole: 1,
        installationPriceProfileId: 1, password: 'Other-password', isActive: false }).expect(200, { firstName: 'Updated' });
    expect(users.updateUser).toHaveBeenLastCalledWith({ where: { id: 7 }, data: { firstName: 'Updated' } });
  });

  it.each(['client', 'dealer', 'operator'])('blocks all category mutations for %s while allowing catalog reads', async role => {
    await request(app.getHttpServer()).get('/api/config-categories').set('Cookie', cookie(role)).expect(200);
    await request(app.getHttpServer()).post('/api/config-categories').set('Cookie', cookie(role)).send({ name: 'New', idProduct: 1 }).expect(403);
    await request(app.getHttpServer()).patch('/api/config-categories/1').set('Cookie', cookie(role)).send({ name: 'Changed' }).expect(403);
    await request(app.getHttpServer()).delete('/api/config-categories/1').set('Cookie', cookie(role)).expect(403);
  });

  it('allows the admin to create, update and delete categories', async () => {
    await request(app.getHttpServer()).post('/api/config-categories').set('Cookie', cookie('admin')).send({ name: 'New', idProduct: 1 }).expect(201);
    await request(app.getHttpServer()).patch('/api/config-categories/1').set('Cookie', cookie('admin')).send({ name: 'Changed' }).expect(200);
    await request(app.getHttpServer()).delete('/api/config-categories/1').set('Cookie', cookie('admin')).expect(200);
  });

  it.each(roles)('protects factory pricing rules from %s according to its role', async role => {
    await request(app.getHttpServer()).get('/api/linear-pricing-rules').set('Cookie', cookie(role))
      .expect(['admin', 'operator'].includes(role) ? 200 : 403);
  });

  it.each(roles)('serializes list, detail and edit responses correctly for %s', async role => {
    const staff = role === 'admin' || role === 'operator';
    const list = await request(app.getHttpServer()).get('/api/estimates').set('Cookie', cookie(role)).expect(200);
    const detail = await request(app.getHttpServer()).get('/api/estimates/1').set('Cookie', cookie(role)).expect(200);
    const edit = await request(app.getHttpServer()).patch('/api/estimates/1/header').set('Cookie', cookie(role)).send({ name: 'Updated' }).expect(200);
    const order = await request(app.getHttpServer()).get('/api/orders/10').set('Cookie', cookie(role)).expect(200);
    for (const result of [list.body[0], detail.body, edit.body, order.body.estimate]) {
      expect(result.priceT).toBe('238.64'); expect(result.customerPriceT).toBe('298.3');
      expect(result.taxAmount).toBe('16.7'); expect(result.paymentSchedule.canRelease).toBe(true);
      expect(result.user.role.name).toBe('dealer'); expect(result.user.username).toBe('owner');
      expect(JSON.stringify(result)).not.toContain('sensitive-hash'); expect(result.user).not.toHaveProperty('sessions');
      expect(result.pieces[0].customerSubtotal).toBe('298.3');
      expect(result.date).toBe(version.toISOString());
      if (staff) { expect(result.rateT).toBe('200'); expect(result.pieces[0].rate).toBe('100'); }
      else {
        for (const key of ['rateT', 'netProfit', 'ownerMarkupSnapshot']) expect(result).not.toHaveProperty(key);
        for (const key of ['rate', 'markup', 'netProfit']) expect(result.pieces[0]).not.toHaveProperty(key);
        expect(result.pieces[0].activeOption).toEqual({ id: 1, name: 'Option' });
        for (const key of ['rate', 'rateReal', 'netProfit', 'netProfitReal', 'poNumber']) expect(order.body).not.toHaveProperty(key);
      }
      if (role === 'client') expect(result).not.toHaveProperty('netProfitD');
      else expect(result.netProfitD).toBe('59.66');
    }
    // Los objetos usados internamente siguen intactos para transacciones y cálculos.
    expect(raw.user.password).toBe('sensitive-hash'); expect(piece.rate.toString()).toBe('100');
  });

  it('filters calculation payloads and nested credentials without damaging binary/decimal values', () => {
    const output = presentApiResponse({ calculation: piece, nested: { passwordHash: 'hash', refreshTokenHash: 'refresh' }, pdf: Buffer.from('PDF') },
      { id: 7, role: { name: 'dealer' } });
    expect(output.calculation).not.toHaveProperty('rate'); expect(output.calculation).not.toHaveProperty('markup');
    expect(output.calculation.netProfitD.toString()).toBe('59.66');
    expect(output.calculation.price.toString()).toBe('119.32');
    expect(output.nested).toEqual({}); expect(output.pdf.toString()).toBe('PDF');
  });
});

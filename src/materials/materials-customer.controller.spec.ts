import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import request = require('supertest');
import { PrismaService } from '@/prisma/prisma.service';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { JwtStrategy } from '@/auth/guards/auth/jwt.strategy';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { RoleName } from '@/auth/types/auth-user.type';
import { PlatformTermsGuard } from '@/platform-terms/platform-terms.guard';
import { MaterialsCustomerCatalogController, MaterialsPublicSalesController, MaterialsSalesController } from './materials-sales.controller';
import { MaterialsSalesService } from './materials-sales.service';
import { MaterialsImagesController } from './materials-images.controller';
import { MaterialsController } from './materials.controller';
import { MaterialsInventoryService } from './materials-inventory.service';
import { readMaterialImage, saveMaterialImage } from './materials-images';

jest.mock('./materials-images', () => ({
  MATERIAL_IMAGE_LIMIT: 5 * 1024 * 1024,
  readMaterialImage: jest.fn(async () => ({ buffer: Buffer.from('test image'), contentType: 'image/png' })),
  saveMaterialImage: jest.fn(async () => ({ imageUrl: `/api/materials/images/${'a'.repeat(64)}.png` })),
}));

describe('Authenticated material shopping routes', () => {
  let app: INestApplication;
  const secret = 'materials-controller-test-only';
  const jwt = new JwtService({ secret });
  const passwordUpdatedAt = new Date('2026-01-01T00:00:00Z');
  const sessions = new Map<string, any>();
  const terms = { assertAccepted: jest.fn(async (_userId: number) => {}) };
  const sales = {
    customerCatalog: jest.fn(async () => ({ products: [], taxRate: '7', currency: 'usd' })),
    createCustomerOrder: jest.fn(async () => ({ id: 1, publicUrl: 'https://example.test/public/material-sales/token' })),
    getPublic: jest.fn(async () => ({ id: 1, status: 'CONFIRMED' })),
    getCustomerOrder: jest.fn(async () => ({ id: 1, status: 'CONFIRMED', canCancel: true })),
    listCustomerOrders: jest.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    cancelCustomerOrder: jest.fn(async () => ({ id: 1, status: 'CANCELED', canCancel: false })),
    list: jest.fn(async () => []),
    searchCustomers: jest.fn(async () => [{ id: 3, name: 'Account Holder', email: 'buyer@example.test', phone: null }] ),
    create: jest.fn(async () => ({ id: 1, status: 'DRAFT' })),
  };
  const inventory = { categories: jest.fn(async () => []), createCategory: jest.fn(async () => ({ id: 1, name: 'Sealants', isActive: true })), updateCategory: jest.fn(async () => ({ id: 1, name: 'Sealants', isActive: false })) };
  const cart = { requestKey: '956fcf32-2cca-4cbf-8e50-cc68919c9ea9', lines: [{ presentationId: 1, quantity: 2 }] };
  function cookie(role: RoleName, expired = false) {
    const id = ['admin', 'operator', 'client', 'dealer', 'technician'].indexOf(role) + 1;
    const sid = `956fcf32-2cca-4cbf-8e50-cc68919c9ea${id}`;
    sessions.set(sid, {
      id: sid, userId: id, revokedAt: null, expiresAt: new Date(Date.now() + 3600000), lastUsedAt: new Date(),
      user: { id, username: role, firstName: 'Account', lastName: 'Holder', email: 'buyer@example.test',
        isActive: true, deletedAt: null, passwordUpdatedAt, parentDealerId: null, networkSuspended: false, role: { name: role } },
    });
    return `access_token=${jwt.sign({ sub: id, sid, tokenType: 'access', passwordVersion: passwordUpdatedAt.getTime() }, { expiresIn: expired ? -1 : 60 })}`;
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MaterialsCustomerCatalogController, MaterialsPublicSalesController, MaterialsSalesController, MaterialsImagesController, MaterialsController],
      providers: [JwtStrategy,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: PrismaService, useValue: { session: { findUnique: async ({ where }) => sessions.get(where.id) } } },
        { provide: MaterialsSalesService, useValue: sales },
        { provide: MaterialsInventoryService, useValue: inventory },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector), new PlatformTermsGuard(reflector, terms as any));
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('requires a valid session for catalog reads and order creation', async () => {
    await request(app.getHttpServer()).get('/api/materials/catalog').expect(401);
    await request(app.getHttpServer()).post('/api/materials/orders').send(cart).expect(401);
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', cookie('client', true)).send(cart).expect(401);
    expect(sales.customerCatalog).not.toHaveBeenCalled();
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
  });

  it('requires authentication and forwards the account identity for order reads and cancellation', async () => {
    await request(app.getHttpServer()).get('/api/materials/orders').expect(401);
    await request(app.getHttpServer()).get('/api/materials/orders').set('Cookie', cookie('technician')).expect(403);
    await request(app.getHttpServer()).get('/api/materials/orders?page=2&pageSize=10').set('Cookie', cookie('client')).expect(200);
    expect(sales.listCustomerOrders).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), { page: '2', pageSize: '10' });
    await request(app.getHttpServer()).get('/api/materials/orders/1').expect(401);
    await request(app.getHttpServer()).post('/api/materials/orders/1/cancel').expect(401);
    await request(app.getHttpServer()).post('/api/materials/orders/1/cancel').set('Cookie', cookie('client', true)).expect(401);
    await request(app.getHttpServer()).get('/api/materials/orders/1').set('Cookie', cookie('technician')).expect(403);
    await request(app.getHttpServer()).post('/api/materials/orders/1/cancel').set('Cookie', cookie('technician')).expect(403);
    expect(sales.getCustomerOrder).not.toHaveBeenCalled();
    expect(sales.cancelCustomerOrder).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/api/materials/orders/1').set('Cookie', cookie('client')).expect(200);
    await request(app.getHttpServer()).post('/api/materials/orders/1/cancel').set('Cookie', cookie('client')).send({ createdById: 99 }).expect(201);
    expect(sales.getCustomerOrder).toHaveBeenCalledWith(1, expect.objectContaining({ id: 3 }));
    expect(sales.cancelCustomerOrder).toHaveBeenCalledWith(1, expect.objectContaining({ id: 3 }));
    await request(app.getHttpServer()).post(`/api/materials/public/sales/${'a'.repeat(64)}/cancel`).set('Cookie', cookie('client')).expect(404);
    expect(sales.cancelCustomerOrder).toHaveBeenCalledTimes(1);
  });

  it('protects image reads and permits uploads only for administrators', async () => {
    const imageUrl = `/api/materials/images/${'a'.repeat(64)}.png`;
    await request(app.getHttpServer()).get(imageUrl).expect(401);
    await request(app.getHttpServer()).get(imageUrl).set('Cookie', cookie('technician')).expect(403);
    expect(readMaterialImage).not.toHaveBeenCalled();
    for (const role of ['client', 'dealer', 'operator', 'admin'] as RoleName[]) {
      await request(app.getHttpServer()).get(imageUrl).set('Cookie', cookie(role)).expect('Content-Type', /image\/png/).expect('Cache-Control', 'private, no-store').expect('X-Content-Type-Options', 'nosniff').expect(200);
    }
    await request(app.getHttpServer()).post('/api/materials/images').set('Cookie', cookie('client')).attach('file', Buffer.from('file'), 'image.png').expect(403);
    await request(app.getHttpServer()).post('/api/materials/images').set('Cookie', cookie('operator')).attach('file', Buffer.from('file'), 'image.png').expect(403);
    expect(saveMaterialImage).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/materials/images').set('Cookie', cookie('admin')).attach('file', Buffer.from('file'), 'image.png').expect(201);
    expect(saveMaterialImage).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).post('/api/materials/images').set('Cookie', cookie('admin')).attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'image.png').expect(413);
    expect(saveMaterialImage).toHaveBeenCalledTimes(1);
  });

  it('keeps category maintenance restricted to administrators and passes catalog filters', async () => {
    const category = { requestKey: cart.requestKey, name: 'Sealants' };
    await request(app.getHttpServer()).get('/api/materials/categories').set('Cookie', cookie('client')).expect(403);
    await request(app.getHttpServer()).get('/api/materials/categories').set('Cookie', cookie('operator')).expect(200);
    await request(app.getHttpServer()).post('/api/materials/categories').set('Cookie', cookie('operator')).send(category).expect(403);
    await request(app.getHttpServer()).post('/api/materials/categories').set('Cookie', cookie('admin')).send(category).expect(201);
    await request(app.getHttpServer()).patch('/api/materials/categories/1').set('Cookie', cookie('admin')).send({ requestKey: cart.requestKey, isActive: false }).expect(200);
    await request(app.getHttpServer()).get('/api/materials/catalog?q=sealant&page=2&categoryId=1').set('Cookie', cookie('client')).expect(200);
    expect(sales.customerCatalog).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), { q: 'sealant', page: '2', categoryId: '1' });
  });

  it.each(['client', 'dealer'] as RoleName[])('allows %s to shop using the authenticated account', async role => {
    const session = cookie(role);
    await request(app.getHttpServer()).get('/api/materials/catalog').set('Cookie', session).expect(200);
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', session).send(cart).expect(201);
    expect(sales.createCustomerOrder).toHaveBeenCalledWith(cart, expect.objectContaining({ role: { name: role } }));
  });

  it.each(['admin', 'operator'] as RoleName[])('lets %s browse and sell for a selected buyer, without implicit self-checkout', async role => {
    const session = cookie(role);
    await request(app.getHttpServer()).get('/api/materials/catalog').set('Cookie', session).expect(200);
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', session).send(cart).expect(403);
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/api/materials/sales').set('Cookie', session).send({ ...cart, storeId: 1, customerUserId: 3 }).expect(201);
    expect(sales.create).toHaveBeenCalledWith({ ...cart, storeId: 1, customerUserId: 3 }, expect.objectContaining({ role: { name: role } }));
    // Historical purchases still use the service's ownership checks.
    await request(app.getHttpServer()).get('/api/materials/orders').set('Cookie', session).expect(200);
    await request(app.getHttpServer()).get('/api/materials/orders/1').set('Cookie', session).expect(200);
    await request(app.getHttpServer()).post('/api/materials/orders/1/cancel').set('Cookie', session).expect(201);
    expect(sales.cancelCustomerOrder).toHaveBeenCalledWith(1, expect.objectContaining({ role: { name: role } }));
  });

  it('uses the current stored account role when a customer becomes staff during the session', async () => {
    const session = cookie('client');
    sessions.get('956fcf32-2cca-4cbf-8e50-cc68919c9ea3').user.role = { name: 'admin' };
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', session).send(cart).expect(403);
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/api/materials/catalog').set('Cookie', session).expect(200);
  });

  it('excludes technicians and keeps warehouse sales management restricted', async () => {
    await request(app.getHttpServer()).get('/api/materials/catalog').set('Cookie', cookie('technician')).expect(403);
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', cookie('technician')).send(cart).expect(403);
    await request(app.getHttpServer()).get('/api/materials/sales').set('Cookie', cookie('client')).expect(403);
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
    expect(sales.list).not.toHaveBeenCalled();
  });

  it('passes staff order-code searches to the full sales query', async () => {
    await request(app.getHttpServer()).get('/api/materials/sales?q=MS-123').set('Cookie', cookie('admin')).expect(200);
    expect(sales.list).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { q: 'MS-123' });
  });

  it('exposes customer lookup only to staff, before the numeric sale route', async () => {
    await request(app.getHttpServer()).get('/api/materials/sales/customers?q=Account').expect(401);
    for (const role of ['client', 'dealer', 'technician'] as RoleName[]) {
      await request(app.getHttpServer()).get('/api/materials/sales/customers?q=Account').set('Cookie', cookie(role)).expect(403);
    }
    expect(sales.searchCustomers).not.toHaveBeenCalled();
    for (const role of ['admin', 'operator'] as RoleName[]) {
      await request(app.getHttpServer()).get('/api/materials/sales/customers?q=Account').set('Cookie', cookie(role)).expect(200);
      expect(sales.searchCustomers).toHaveBeenLastCalledWith(expect.objectContaining({ role: { name: role } }), { q: 'Account' });
    }
  });

  it('accepts selected or manual direct-sale customers and validates optional contact data', async () => {
    const payload = { ...cart, storeId: 1 };
    const session = cookie('admin');
    await request(app.getHttpServer()).post('/api/materials/sales').set('Cookie', session).send({ ...payload, customerUserId: 3 }).expect(201);
    expect(sales.create).toHaveBeenLastCalledWith({ ...payload, customerUserId: 3 }, expect.objectContaining({ id: 1 }));
    await request(app.getHttpServer()).post('/api/materials/sales').set('Cookie', session).send({ ...payload, customerName: ' Walk-in Buyer ', customerEmail: ' WALKIN@example.test ', customerPhone: '555-0100' }).expect(201);
    expect(sales.create).toHaveBeenLastCalledWith({ ...payload, customerName: 'Walk-in Buyer', customerEmail: 'walkin@example.test', customerPhone: '555-0100' }, expect.objectContaining({ id: 1 }));
    await request(app.getHttpServer()).post('/api/materials/sales').set('Cookie', session).send({ ...payload, customerName: 'Walk-in Buyer' }).expect(201);
    const validCalls = sales.create.mock.calls.length;
    for (const invalid of [{}, { customerName: '' }, { customerUserId: 0 }, { customerUserId: 1.5 }, { customerName: 'Buyer', customerEmail: 'not-an-email' }, { customerName: 'Buyer', customerPhone: '1'.repeat(41) }]) {
      await request(app.getHttpServer()).post('/api/materials/sales').set('Cookie', session).send({ ...payload, ...invalid }).expect(400);
    }
    expect(sales.create).toHaveBeenCalledTimes(validCalls);
  });

  it('removes customer identity and account IDs from submitted data', async () => {
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', cookie('client')).send({
      ...cart, customerName: 'Someone else', customerEmail: 'someone@example.test', customerPhone: '000', userId: 99, createdById: 99,
    }).expect(201);
    expect(sales.createCustomerOrder).toHaveBeenCalledWith(cart, expect.objectContaining({ id: 3, email: 'buyer@example.test' }));
  });

  it('requires the same accepted platform terms as other account purchases', async () => {
    terms.assertAccepted.mockRejectedValueOnce(new ForbiddenException('Accept the platform terms.'));
    await request(app.getHttpServer()).post('/api/materials/orders').set('Cookie', cookie('client')).send(cart).expect(403);
    expect(terms.assertAccepted).toHaveBeenCalledWith(3);
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
  });

  it('has no legacy anonymous catalog or order route while keeping token payment links accessible', async () => {
    await request(app.getHttpServer()).get('/api/materials/public/catalog').set('Cookie', cookie('client')).expect(404);
    await request(app.getHttpServer()).post('/api/materials/public/orders').set('Cookie', cookie('client')).send(cart).expect(404);
    await request(app.getHttpServer()).get(`/api/materials/public/sales/${'a'.repeat(64)}`).expect(200);
    expect(sales.createCustomerOrder).not.toHaveBeenCalled();
    expect(sales.getPublic).toHaveBeenCalledWith('a'.repeat(64));
    expect(terms.assertAccepted).not.toHaveBeenCalled();
  });
});

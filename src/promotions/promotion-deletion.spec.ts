import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request = require('supertest');
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

describe('Deleting promotions through the admin API', () => {
  let app: INestApplication;
  const offer = {
    id: 1,
    name: 'Launch offer',
    version: 1,
    percent: new Prisma.Decimal(20),
    audience: 'ALL',
    roleIds: [],
    userIds: [],
    excludedProductIds: [],
    excludedSystemIds: [],
    brandId: null,
    productId: null,
    systemId: null,
    startsAt: new Date('2026-01-01'),
    endsAt: new Date('2099-01-01'),
    enabled: true,
  };
  const rows = new Map<number, typeof offer>();
  const historicalEstimate = {
    idUser: 7,
    ownerMarkupSnapshot: new Prisma.Decimal('.2'),
    priceT: new Prisma.Decimal(80),
    promotionLockedAt: new Date('2026-09-09'),
    pieces: [
      {
        price: new Prisma.Decimal(80),
        regularPrice: new Prisma.Decimal(100),
        promotionSnapshot: {
          id: 1,
          version: 1,
          name: 'Launch offer',
          percent: '20',
          startsAt: offer.startsAt.toISOString(),
          endsAt: offer.endsAt.toISOString(),
        },
      },
    ],
    order: { amount: new Prisma.Decimal('85.60') },
    payments: [{ status: 'PAID', amount: new Prisma.Decimal('85.60') }],
  };
  const db = {
    promotion: {
      findMany: jest.fn(async (args: any) =>
        [...rows.values()]
          .filter(
            (row) =>
              !args?.where ||
              (row.enabled === args.where.enabled &&
                row.startsAt <= args.where.startsAt.lte &&
                row.endsAt > args.where.endsAt.gt),
          )
          .sort((a, b) => b.id - a.id),
      ),
      findUnique: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
      deleteMany: jest.fn(async ({ where }) => ({
        count: rows.delete(where.id) ? 1 : 0,
      })),
    },
    user: {
      findUniqueOrThrow: jest.fn(async () => ({
        idRole: 1,
        role: { name: 'client' },
      })),
    },
    brand: { findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => []) },
    system: { findMany: jest.fn(async () => []) },
    estimate: { findUnique: jest.fn(async () => historicalEstimate) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PromotionsController],
      providers: [
        PromotionsService,
        { provide: PrismaService, useValue: db },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    // Identidad simulada, controlador y guard de roles reales; sin DB externa.
    app.use((req: any, _res: any, next: () => void) => {
      const role = req.headers['x-test-role'];
      if (role) req.user = { id: 7, role: { name: role } };
      next();
    });
    await app.init();
  });

  beforeEach(() => {
    rows.clear();
    rows.set(1, { ...offer });
    rows.set(2, { ...offer, id: 2, name: 'Paused offer', enabled: false });
  });

  afterAll(async () => app?.close());

  it('removes the selected offer from the catalog and future eligibility, preserving saved discounts', async () => {
    const saved = JSON.stringify(historicalEstimate);
    const before = await request(app.getHttpServer())
      .get('/api/promotions/available')
      .set('x-test-role', 'client')
      .expect(200);
    expect(before.body.promotions.map((p: any) => p.id)).toEqual([1]);

    await request(app.getHttpServer())
      .delete('/api/promotions/1')
      .set('x-test-role', 'admin')
      .expect(204);

    const list = await request(app.getHttpServer())
      .get('/api/promotions')
      .set('x-test-role', 'admin')
      .expect(200);
    expect(list.body.map((p: any) => p.id)).toEqual([2]);
    const after = await request(app.getHttpServer())
      .get('/api/promotions/available/estimate/42')
      .set('x-test-role', 'client')
      .expect(200);
    expect(after.body.promotions).toEqual([]);
    expect(JSON.stringify(historicalEstimate)).toBe(saved);
  });

  it('permanently removes a paused offer and refuses to reactivate its deleted ID', async () => {
    await request(app.getHttpServer())
      .delete('/api/promotions/2')
      .set('x-test-role', 'admin')
      .expect(204);
    await request(app.getHttpServer())
      .put('/api/promotions/2')
      .set('x-test-role', 'admin')
      .send({
        name: offer.name,
        startsAt: offer.startsAt.toISOString(),
        endsAt: offer.endsAt.toISOString(),
        enabled: true,
      })
      .expect(404);
    expect([...rows.keys()]).toEqual([1]);
  });

  it.each(['client', 'dealer', 'operator', undefined])(
    'rejects deletion for %s without changing promotions',
    async (role) => {
      const req = request(app.getHttpServer()).delete('/api/promotions/1');
      if (role) req.set('x-test-role', role);
      await req.expect(403);
      expect([...rows.keys()]).toEqual([1, 2]);
    },
  );

  it('returns 404 for a missing ID and keeps the other offers', async () => {
    await request(app.getHttpServer())
      .delete('/api/promotions/999')
      .set('x-test-role', 'admin')
      .expect(404);
    expect([...rows.keys()]).toEqual([1, 2]);
  });

  it('rejects an invalid ID before deleting anything', async () => {
    await request(app.getHttpServer())
      .delete('/api/promotions/not-an-id')
      .set('x-test-role', 'admin')
      .expect(400);
    expect([...rows.keys()]).toEqual([1, 2]);
  });
});

import { BadRequestException, Controller, Get, INestApplication, Injectable, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AuthService } from '@/auth/auth.service';
import { RegisterUserDto } from '@/auth/dto/register-user.dto';
import { AuthController } from '@/auth/auth.controller';
import { IS_PUBLIC_KEY, Public } from '@/auth/public.decorator';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { PlatformTermsController } from './platform-terms.controller';
import { PlatformTermsGuard } from './platform-terms.guard';
import { PlatformTermsService } from './platform-terms.service';
import { AcceptPlatformTermsDto } from './platform-terms.dto';
import { needsPlatformTerms } from './platform-terms.policy';
import { ALLOW_BEFORE_PLATFORM_TERMS } from './platform-terms.decorator';

const admin = { id: 1, role: { name: 'admin' as const } };

// Se ejercitan servicios y guards reales con almacenamiento aislado de producción.
function fixture() {
  const state: any = {
    currentId: null, versions: [], acceptances: [], registered: [], sms: [], events: [],
    users: [
      admin, { id: 2, role: { name: 'operator' } },
      { id: 3, role: { name: 'client' } },
      { id: 4, role: { name: 'dealer' }, dealerMode: 'EXTERNAL' },
      { id: 5, role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
      { id: 6, role: { name: 'dealer' }, dealerMode: null },
    ],
  };
  const db: any = {
    platformTermsState: {
      findUniqueOrThrow: jest.fn(async () => ({ currentVersion: state.versions.find(v => v.id === state.currentId) ?? null })),
      update: jest.fn(async ({ data }) => { state.currentId = data.currentVersionId; }),
    },
    platformTermsVersion: {
      create: jest.fn(async ({ data }) => {
        const version = { ...data, id: state.versions.length + 1, publishedAt: new Date() };
        state.versions.push(version); return version;
      }),
      findUnique: jest.fn(async ({ where }) => state.versions.find(v => v.id === where.id) ?? null),
      findMany: jest.fn(async () => [...state.versions].reverse().map(v => ({
        ...v, _count: { acceptances: state.acceptances.filter(a => a.versionId === v.id).length },
      }))),
    },
    platformTermsAcceptance: {
      findUnique: jest.fn(async ({ where }) => state.acceptances.find(a =>
        a.userId === where.userId_versionId.userId && a.versionId === where.userId_versionId.versionId) ?? null),
      upsert: jest.fn(async ({ create }) => {
        if (state.failAcceptance) throw new Error('Acceptance storage unavailable');
        const existing = state.acceptances.find(a => a.userId === create.userId && a.versionId === create.versionId);
        if (existing) return existing;
        const acceptance = { ...create, id: state.acceptances.length + 1, acceptedAt: new Date() };
        state.acceptances.push(acceptance); return acceptance;
      }),
      findMany: jest.fn(async ({ where }) => state.acceptances.filter(a => a.userId === where.userId)
        .map(a => ({ ...a, version: state.versions.find(v => v.id === a.versionId) }))),
    },
    user: {
      findUniqueOrThrow: jest.fn(async ({ where }) => {
        const user = state.users.find(u => u.id === where.id);
        if (!user) throw new Error('Account not found');
        return user;
      }),
      create: jest.fn(async ({ data }) => {
        const user = { ...data, id: 100 + state.registered.length };
        state.registered.push(user); return user;
      }),
    },
    role: { findUnique: jest.fn(async () => ({ id: 3 })) },
    registrationConsent: { create: jest.fn(async ({ data }) => { state.sms.push(data); }) },
    smsConsent: { create: jest.fn() },
    smsConsentEvent: { create: jest.fn(async ({ data }) => { state.events.push(data); }) },
    smsPhoneBlock: { findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => [{ id: 1 }]),
  };
  // Reproduce la serialización del SELECT FOR UPDATE para carreras entre solicitudes.
  let queue = Promise.resolve();
  db.$transaction = (run: any) => {
    const work = queue.then(async () => {
      const before = structuredClone(state);
      try { return await run(db); }
      catch (error) { Object.assign(state, before); throw error; }
    });
    queue = work.then(() => undefined, () => undefined);
    return work;
  };
  const service = new PlatformTermsService(db);
  const publish = async (text = 'Example platform terms') => service.publishText(admin, text, state.currentId ?? 0);
  const auth = new AuthService({} as any, db, {} as any, {} as any, {} as any,
    { getProgram: async () => ({ version: 'a'.repeat(64), registration: {} }) } as any,
    { checkAddress: async () => ({ available: true }) } as any);
  const registration = (extra = {}) => ({
    username: 'client-one', firstName: 'Test', lastName: 'Client', email: 'client@example.test',
    phone: '+13055550123', street: 'Example Street', city: 'Miami', state: 'FL', postalCode: '33101',
    password: 'Example-password-123', serviceConsent: false, promotionsConsent: false, ...extra,
  } as any);
  return { state, db, service, publish, auth, registration };
}

describe('Platform terms — account and version acceptance', () => {
  it.each([
    ['client', null, true], ['dealer', 'EXTERNAL', true], ['dealer', null, true],
    ['dealer', 'INTERNAL', false], ['admin', null, false], ['operator', null, false],
  ])('applies to %s / %s: %s', (role, dealerMode, expected) => {
    expect(needsPlatformTerms({ role: { name: role as string }, dealerMode: dealerMode as string })).toBe(expected);
  });

  it('allows existing accounts until the administrator publishes the first document', async () => {
    const f = fixture();
    expect(await f.service.status(3)).toMatchObject({ current: null, applies: true, required: false, acceptedAt: null });
    await expect(f.service.assertAccepted(3)).resolves.toBeUndefined();
    expect(f.state.acceptances).toHaveLength(0);
  });

  it('requires clients and external dealers; exempts staff and internal dealers', async () => {
    const f = fixture(); await f.publish();
    for (const id of [3, 4, 6]) expect((await f.service.status(id)).required).toBe(true);
    for (const id of [1, 2, 5]) {
      expect(await f.service.status(id)).toMatchObject({ applies: false, required: false, acceptedAt: null });
      await expect(f.service.assertAccepted(id)).resolves.toBeUndefined();
      await expect(f.service.accept(id, true, 1)).rejects.toThrow('does not require');
    }
    expect(f.state.acceptances).toHaveLength(0);
  });

  it('keeps one acceptance per account/version across repeated operations and retries', async () => {
    const f = fixture(); await f.publish();
    const first = await f.service.accept(3, true, 1);
    const retry = await f.service.accept(3, true, 1);
    expect(retry.acceptedAt).toEqual(first.acceptedAt);
    expect(f.state.acceptances).toHaveLength(1);
    for (let index = 0; index < 5; index++) await expect(f.service.assertAccepted(3)).resolves.toBeUndefined();
    expect((await f.service.status(4)).required).toBe(true);
    expect(f.db.$queryRaw).toHaveBeenCalled();
  });

  it('requires a new version while preserving earlier text and evidence', async () => {
    const f = fixture(); await f.publish('Version one');
    await f.service.accept(3, true, 1);
    const original = await f.service.document(1);
    const proof = structuredClone(f.state.acceptances[0]);
    await f.publish('Version two');
    expect((await f.service.status(3)).required).toBe(true);
    expect((await f.service.status(5)).required).toBe(false);
    await expect(f.service.accept(3, true, 1)).rejects.toThrow('changed');
    expect(f.state.acceptances[0]).toEqual(proof);
    await expect(f.service.document(1)).rejects.toThrow('not found');
    expect(await f.service.administrationDocument(admin, 1)).toEqual(original);
    await f.service.accept(3, true, 2);
    expect(f.state.acceptances).toHaveLength(2);
    expect((await f.service.status(3)).required).toBe(false);
  });

  it('uses the current account classification instead of a stale session role', async () => {
    const f = fixture(); await f.publish();
    expect((await f.service.status(5)).required).toBe(false);
    f.state.users.find(u => u.id === 5).dealerMode = 'EXTERNAL';
    expect((await f.service.status(5)).required).toBe(true);
    await f.service.accept(5, true, 1);
    f.state.users.find(u => u.id === 5).dealerMode = 'INTERNAL';
    await f.publish('New version');
    expect((await f.service.status(5)).required).toBe(false);
    expect(f.state.acceptances).toHaveLength(1);
  });

  it.each([false, undefined, null, 'true', 'false', 1, 0])('rejects acceptance value %p', async accepted => {
    const f = fixture(); await f.publish();
    await expect(f.service.accept(3, accepted, 1)).rejects.toThrow();
    expect(f.state.acceptances).toHaveLength(0);
  });

  it('validates explicit acceptance through the application validation pipe', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
    for (const metatype of [AcceptPlatformTermsDto, RegisterUserDto]) {
      for (const value of [null, 'true', 'false', 1, 0]) {
        const payload = metatype === AcceptPlatformTermsDto ? { accepted: value, versionId: 1 } :
          fixture().registration({ platformTermsAccepted: value, platformTermsVersionId: 1 });
        await expect(pipe.transform(payload, { type: 'body', metatype })).rejects.toThrow();
      }
    }
    expect(await pipe.transform({ accepted: true, versionId: 1, userId: 4 },
      { type: 'body', metatype: AcceptPlatformTermsDto })).toEqual({ accepted: true, versionId: 1 });
  });


  it('rejects outdated publication without creating a version', async () => {
    const f = fixture(); await f.publish();
    await expect(f.service.publishText(admin, 'Another', 0)).rejects.toThrow('Another version');
    expect(f.state.versions).toHaveLength(1);
  });




  it('returns only the requesting account history and excludes internal storage keys', async () => {
    const f = fixture(); await f.publish(); await f.service.accept(3, true, 1);
    expect(await f.service.myHistory(4)).toEqual([]);
    expect(await f.service.myHistory(3)).toHaveLength(1);
    expect(await f.service.current()).not.toHaveProperty('fileKey');
    expect(await f.service.administration(admin)).toMatchObject({ versions: [{ acceptanceCount: 1 }] });
  });

  it('keeps platform acceptance independent of all four SMS preference combinations', async () => {
    for (const serviceConsent of [true, false]) for (const promotionsConsent of [true, false]) {
      const f = fixture(); await f.publish();
      const user = await f.auth.registerUser(f.registration({ platformTermsAccepted: true,
        platformTermsVersionId: 1, serviceConsent, promotionsConsent, consentVersion: 'a'.repeat(64) }));
      expect(f.state.acceptances).toMatchObject([{ userId: user.id, versionId: 1, source: 'REGISTRATION' }]);
      expect(f.state.sms[0]).toMatchObject({ serviceSmsAccepted: serviceConsent, promotionalSmsAccepted: promotionsConsent });
      expect(f.state.events).toHaveLength(Number(serviceConsent) + Number(promotionsConsent));
      expect(f.state.registered[0]).not.toHaveProperty('platformTermsAccepted');
      expect(f.state.registered[0]).not.toHaveProperty('platformTermsVersionId');
    }
  });

  it('rejects registration without acceptance or with a stale version before creating an account', async () => {
    const f = fixture(); await f.publish();
    for (const fields of [{}, { platformTermsAccepted: false },
      { platformTermsAccepted: true, platformTermsVersionId: 99 }]) {
      await expect(f.auth.registerUser(f.registration(fields))).rejects.toThrow();
    }
    expect(f.state.registered).toHaveLength(0); expect(f.state.sms).toHaveLength(0);
  });

  it('rolls back account creation if its platform acceptance cannot be saved', async () => {
    const f = fixture(); await f.publish(); f.state.failAcceptance = true;
    await expect(f.auth.registerUser(f.registration({ platformTermsAccepted: true, platformTermsVersionId: 1 }))).rejects.toThrow();
    expect(f.state.registered).toHaveLength(0); expect(f.state.acceptances).toHaveLength(0);
    expect(f.state.sms).toHaveLength(0);
  });

  it('keeps session identification, logout and password changes available before acceptance', () => {
    const reflector = new Reflector();
    for (const method of ['getProfile', 'logout', 'changePassword'])
      expect(reflector.get(ALLOW_BEFORE_PLATFORM_TERMS, AuthController.prototype[method])).toBe(true);
    expect(reflector.get(ALLOW_BEFORE_PLATFORM_TERMS, AuthController.prototype.updateProfile)).toBeUndefined();
  });
});

describe('Platform terms — editable web versions', () => {
  const content = '## Platform use\n\nKeep your account details accurate.\n\n- First requirement\n- Second requirement';

  it('publishes text, preserves it in history, and accepts it without a PDF', async () => {
    const f = fixture();
    const first = await f.service.publishText(admin, content, 0);
    expect(first).toMatchObject({ changed: true, current: { id: 1 } });
    expect(await f.service.document(1)).toMatchObject({ content, version: { id: 1 } });
    expect(await f.service.status(3)).toMatchObject({ required: true });
    await f.service.accept(3, true, 1);
    const acceptedAt = f.state.acceptances[0].acceptedAt;
    await f.service.accept(3, true, 1);
    expect(f.state.acceptances[0].acceptedAt).toEqual(acceptedAt);
    expect(await f.service.status(3)).toMatchObject({ required: false });
    await f.service.publishText(admin, content + '\n\nNew provision.', 1);
    expect(await f.service.status(3)).toMatchObject({ required: true, current: { id: 2 } });
    expect((await f.service.administrationDocument(admin, 1)).content).toBe(content);
    expect(await f.service.myHistory(3)).toMatchObject([{ version: { id: 1 }, acceptedAt }]);
    await expect(f.service.accept(3, true, 1)).rejects.toThrow('changed');
  });

  it('does not create a new version or reset acceptance when the text is unchanged', async () => {
    const f = fixture();
    await f.service.publishText(admin, content, 0);
    await f.service.accept(3, true, 1);
    const result = await f.service.publishText(admin, '\n' + content.replace(/\n/g, '\r\n') + '\n', 1);
    expect(result.changed).toBe(false);
    expect(f.state.versions).toHaveLength(1);
    expect((await f.service.status(3)).required).toBe(false);
  });


  it('rejects empty, oversized and non-string text and publication by non-admins', async () => {
    const f = fixture();
    for (const value of ['', ' \r\n ', false, 5, {}, 'a'.repeat(500001)])
      await expect(f.service.publishText(admin, value, 0)).rejects.toThrow();
    for (const id of [2, 3, 4, 5])
      await expect(f.service.publishText(f.state.users.find(u => u.id === id), content, 0)).rejects.toThrow('administrators');
    expect(f.state.versions).toHaveLength(0);
  });

  it('serializes competing text publications and keeps the winning content intact', async () => {
    const f = fixture(); await f.service.publishText(admin, content, 0);
    const results = await Promise.allSettled([
      f.service.publishText(admin, 'Second version.', 1), f.service.publishText(admin, 'Competing version.', 1),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.state.versions).toHaveLength(2);
    expect((await f.service.document(2)).content).toBe('Second version.');
  });

  it('does not display or accept text changed outside the publication workflow', async () => {
    const f = fixture(); await f.service.publishText(admin, content, 0);
    f.state.versions[0].content = 'Modified without publication.';
    await expect(f.service.document(1)).rejects.toThrow('unavailable');
    await expect(f.service.accept(3, true, 1)).rejects.toThrow('unavailable');
    expect(f.state.acceptances).toHaveLength(0);
  });

  it('restricts archived documents to administrators without changing their contents', async () => {
    const f = fixture();
    await expect(f.service.document(1)).rejects.toThrow('not found');
    await f.publish('Original terms');
    await f.publish('Updated terms');
    await expect(f.service.document(1)).rejects.toThrow('not found');
    expect((await f.service.document(2)).content).toBe('Updated terms');
    for (const id of [2, 3, 4, 5, 6])
      await expect(f.service.administrationDocument(f.state.users.find(u => u.id === id), 1)).rejects.toThrow('administrators');
    expect((await f.service.administrationDocument(admin, 1)).content).toBe('Original terms');
  });

  it('supports registration acceptance for a text version without enabling optional SMS', async () => {
    const f = fixture(); await f.service.publishText(admin, content, 0);
    const user = await f.auth.registerUser(f.registration({ platformTermsAccepted: true, platformTermsVersionId: 1 }));
    expect(f.state.acceptances).toMatchObject([{ userId: user.id, versionId: 1, source: 'REGISTRATION' }]);
    expect(f.state.sms[0]).toMatchObject({ serviceSmsAccepted: false, promotionalSmsAccepted: false });
    expect(f.state.events).toHaveLength(0);
  });
});

@Controller('workflow')
class ProtectedWorkflowController {
  @Get() protectedAction() { return { ok: true }; }
  @Public() @Get('public') publicAction() { return { public: true }; }
}

describe('Platform terms HTTP enforcement', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture(); await f.publish();
    const reflector = new Reflector();
    const module = await Test.createTestingModule({
      controllers: [PlatformTermsController, ProtectedWorkflowController],
      providers: [
        { provide: PlatformTermsService, useValue: f.service },
        { provide: APP_GUARD, useValue: { canActivate(context) {
          if (reflector.getAllAndOverride(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
          const req = context.switchToHttp().getRequest();
          req.user = f.state.users.find(u => u.id === Number(req.headers['test-user']));
          if (!req.user) throw new UnauthorizedException();
          return true;
        } } },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PlatformTermsGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  it('allows document access and public workflows without a platform account', async () => {
    await request(app.getHttpServer()).get('/platform-terms/current').expect(200);
    await request(app.getHttpServer()).get('/platform-terms/1/document').expect(200);
    await request(app.getHttpServer()).get('/workflow/public').expect(200);
    await request(app.getHttpServer()).get('/platform-terms/status').expect(401);
    await request(app.getHttpServer()).post('/platform-terms/accept').send({ accepted: true, versionId: 1 }).expect(401);
  });

  it('blocks authenticated operations until acceptance, including sessions open during a publication', async () => {
    const server = app.getHttpServer();
    const denied = await request(server).get('/workflow').set('test-user', '3').expect(403);
    expect(denied.body.code).toBe('PLATFORM_TERMS_REQUIRED');
    await request(server).get('/platform-terms/status').set('test-user', '3').expect(200);
    await request(server).post('/platform-terms/accept').set('test-user', '3').send({ accepted: true, versionId: 1, userId: 4 }).expect(201);
    expect(f.state.acceptances[0].userId).toBe(3);
    await request(server).get('/workflow').set('test-user', '3').expect(200);
    await f.publish('New policy');
    await request(server).get('/workflow').set('test-user', '3').expect(403);
    await request(server).post('/platform-terms/accept').set('test-user', '3').send({ accepted: true, versionId: 1 }).expect(409);
  });

  it('exempts only admin, operator and internal dealer accounts', async () => {
    for (const id of [1, 2, 5]) await request(app.getHttpServer()).get('/workflow').set('test-user', String(id)).expect(200);
    for (const id of [3, 4, 6]) await request(app.getHttpServer()).get('/workflow').set('test-user', String(id)).expect(403);
  });

  it('restricts publication and administration to admins, independently of terms exemption', async () => {
    for (const id of [2, 3, 4, 5]) {
      await request(app.getHttpServer()).get('/platform-terms/admin').set('test-user', String(id)).expect(403);
      await request(app.getHttpServer()).post('/platform-terms/publish-text').set('test-user', String(id)).expect(403);
    }
    await request(app.getHttpServer()).get('/platform-terms/admin').set('test-user', '1').expect(200);
    await request(app.getHttpServer()).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', 'New terms text.').expect(201);
    expect(f.state.currentId).toBe(2);
  });
  it('publishes text through the admin endpoint and serves exact current content publicly', async () => {
    const server = app.getHttpServer();
    for (const id of [2, 3, 4, 5])
      await request(server).post('/platform-terms/publish-text').set('test-user', String(id))
        .field('currentVersionId', '1').field('content', 'Forbidden content.').expect(403);
    await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', ' \n ').expect(400);
    const text = '## Account use\n\nTerms with accents: aceptación. <script>literal text</script>';
    const saved = await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', text).expect(201);
    expect(saved.body.current).toMatchObject({ id: 2 });
    expect(saved.body.current).not.toHaveProperty('content');
    const document = await request(server).get('/platform-terms/2/document').expect(200);
    expect(document.body.content).toBe(text);
    expect(document.body.version).not.toHaveProperty('fileKey');
    await request(server).get('/platform-terms/2/pdf').set('test-user', '1').expect(404);
    await request(server).post('/platform-terms/accept').set('test-user', '3')
      .send({ accepted: true, versionId: 2 }).expect(201);
    await request(server).get('/workflow').set('test-user', '3').expect(200);
    await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', 'Stale draft.').expect(409);
    await request(server).get('/platform-terms/999/document').expect(404);
  });

  it('serves archived text only through the protected administration endpoint', async () => {
    const server = app.getHttpServer();
    await f.service.accept(3, true, 1);
    await f.publish('Updated public terms');
    await request(server).get('/platform-terms/1/document').expect(404);
    await request(server).get('/platform-terms/1/document').set('test-user', '3').expect(404);
    await request(server).get('/platform-terms/admin/1/document').expect(401);
    for (const id of [2, 3, 4, 5, 6])
      await request(server).get('/platform-terms/admin/1/document').set('test-user', String(id)).expect(403);
    const archived = await request(server).get('/platform-terms/admin/1/document').set('test-user', '1').expect(200);
    expect(archived.body.content).toBe('Example platform terms');
    expect(archived.headers['cache-control']).toBe('private, no-store');
    const current = await request(server).get('/platform-terms/2/document').expect(200);
    expect(current.body.content).toBe('Updated public terms');
    await request(server).get('/platform-terms/admin/999/document').set('test-user', '1').expect(404);
    expect(f.state.acceptances).toMatchObject([{ userId: 3, versionId: 1 }]);
    expect((await f.service.status(3)).required).toBe(true);
  });

  it('removes PDF publication and download, and rejects file uploads to the text endpoint', async () => {
    const server = app.getHttpServer();
    await request(server).post('/platform-terms/publish').set('test-user', '1').expect(404);
    await request(server).get('/platform-terms/1/pdf').set('test-user', '1').expect(404);
    await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').attach('file', Buffer.from('%PDF-test'), 'test.pdf').expect(400);
    expect(f.state.versions).toHaveLength(1);
  });

  it('publishes imported document content and rejects malformed rich text', async () => {
    const server = app.getHttpServer();
    const document = 'PLATFORM_TERMS_RICH_TEXT_V1\n' + JSON.stringify({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Imported terms' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Full imported wording.', marks: [{ type: 'bold' }] }] },
    ] });
    await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', 'PLATFORM_TERMS_RICH_TEXT_V1\n{}').expect(400);
    await request(server).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', document).expect(201);
    const stored = await request(server).get('/platform-terms/2/document').expect(200);
    expect(stored.body.content).toBe(document);
    await request(server).post('/platform-terms/accept').set('test-user', '3')
      .send({ accepted: true, versionId: 2 }).expect(201);
    await request(server).get('/workflow').set('test-user', '3').expect(200);
  });

  it('accepts long Unicode terms within the limit using multipart text', async () => {
    const content = 'Condición de uso. '.repeat(6000);
    const response = await request(app.getHttpServer()).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '1').field('content', content).expect(201);
    expect(response.body.current.sizeBytes).toBe(Buffer.byteLength(content.trim()));
    await request(app.getHttpServer()).post('/platform-terms/publish-text').set('test-user', '1')
      .field('currentVersionId', '2').field('content', 'a'.repeat(500001)).expect(400);
  });

});

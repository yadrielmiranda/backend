import { HttpService } from '@nestjs/axios';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { of, throwError } from 'rxjs';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import { JwtStrategy } from '@/auth/guards/auth/jwt.strategy';
import { SessionTouchGuard } from '@/auth/guards/auth/session-touch.guard';
import { RolesGuard } from '@/auth/guards/roles/roles.guard';
import { PlatformTermsGuard } from '@/platform-terms/platform-terms.guard';
import { PlatformTermsService } from '@/platform-terms/platform-terms.service';
import { PrismaService } from '@/prisma/prisma.service';
import { GooglePlacesController } from './google-places.controller';
import { GooglePlacesService } from './google-places.service';
import { RegistrationPlacesController } from './registration-places.controller';
import { RegistrationPlacesService } from './registration-places.service';

const token = '0226ff61-70bc-410e-95e1-49d29cf068bc';
const placeId = 'ChIJ_public-registration';
const input = { input: '123 Example St', sessionToken: token };
const selection = { placeId, sessionToken: token };
const suggestion = {
  placeId,
  text: '123 Example St, El Portal, FL, USA',
  mainText: '123 Example St',
  secondaryText: 'El Portal, FL, USA',
};
const address = {
  street: '123 Example St',
  city: 'El Portal',
  state: 'FL',
  postalCode: '33138',
};
const prefix = '/api/geo/registration/places';

describe('Registration Places public HTTP boundary', () => {
  let app: INestApplication;
  let post: jest.Mock;
  let get: jest.Mock;
  const touchSession = jest.fn();
  const acceptTerms = jest.fn();

  beforeEach(async () => {
    post = jest.fn().mockReturnValue(
      of({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId,
                text: { text: suggestion.text },
                structuredFormat: {
                  mainText: { text: suggestion.mainText },
                  secondaryText: { text: suggestion.secondaryText },
                },
              },
            },
          ],
        },
      }),
    );
    get = jest.fn().mockReturnValue(
      of({
        data: {
          addressComponents: [
            ['street_number', '123', '123'],
            ['route', 'Example Street', 'Example St'],
            ['locality', 'El Portal', 'El Portal'],
            ['administrative_area_level_1', 'Florida', 'FL'],
            ['postal_code', '33138', '33138'],
            ['country', 'United States', 'US'],
          ].map(([type, longText, shortText]) => ({
            types: [type],
            longText,
            shortText,
          })),
        },
      }),
    );
    touchSession.mockClear();
    acceptTerms.mockClear();
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [GooglePlacesController, RegistrationPlacesController],
      providers: [
        GooglePlacesService,
        RegistrationPlacesService,
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET_KEY' ? 'test-jwt-secret' : 'server-key',
          },
        },
        { provide: HttpService, useValue: { post, get } },
        {
          provide: PrismaService,
          useValue: { session: { updateMany: touchSession } },
        },
        {
          provide: PlatformTermsService,
          useValue: { assertAccepted: acceptTerms },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: SessionTouchGuard },
        { provide: APP_GUARD, useClass: PlatformTermsGuard },
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
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('allows registration without JWT or terms acceptance and keeps existing routes private', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/autocomplete`)
      .send({ ...input, input: `  ${input.input}  `, url: 'ignored' })
      .expect(201, { suggestions: [suggestion] });
    await request(app.getHttpServer())
      .post(`${prefix}/details`)
      .send(selection)
      .expect(201, address);
    expect(post.mock.calls[0][1].input).toBe(input.input);
    expect(post.mock.calls[0][1]).not.toHaveProperty('url');
    expect(touchSession).not.toHaveBeenCalled();
    expect(acceptTerms).not.toHaveBeenCalled();
    for (const method of ['autocomplete', 'details']) {
      await request(app.getHttpServer())
        .post(`/api/geo/places/${method}`)
        .send({ ...input, ...selection })
        .expect(401);
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['autocomplete', { ...input, input: '  ' }],
    ['autocomplete', { ...input, input: 'x'.repeat(201) }],
    ['autocomplete', { input: input.input }],
    ['autocomplete', { ...input, sessionToken: 'x'.repeat(37) }],
    ['details', { ...selection, placeId: '../unsafe' }],
    ['details', { placeId }],
  ])('validates public %s before calling Google: %p', async (method, body) => {
    await request(app.getHttpServer())
      .post(`${prefix}/${method}`)
      .send(body)
      .expect(400);
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('requires a suggested ID and the matching session, then consumes it once', async () => {
    await request(app.getHttpServer())
      .post(`${prefix}/details`)
      .send(selection)
      .expect(400);
    await request(app.getHttpServer())
      .post(`${prefix}/autocomplete`)
      .send(input)
      .expect(201);
    for (const invalid of [
      { ...selection, sessionToken: 'other-token' },
      { ...selection, placeId: 'ChIJ_not-suggested' },
    ]) {
      await request(app.getHttpServer())
        .post(`${prefix}/details`)
        .send(invalid)
        .expect(400);
    }
    await request(app.getHttpServer())
      .post(`${prefix}/details`)
      .send(selection)
      .expect(201);
    await request(app.getHttpServer())
      .post(`${prefix}/details`)
      .send(selection)
      .expect(400);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns 429 despite rotating tokens and spoofed forwarding headers', async () => {
    for (let i = 0; i < 60; i++) {
      await request(app.getHttpServer())
        .post(`${prefix}/autocomplete`)
        .set('X-Forwarded-For', `192.0.2.${i}`)
        .send({ ...input, sessionToken: `token-${i}` })
        .expect(201);
    }
    const limited = await request(app.getHttpServer())
      .post(`${prefix}/autocomplete`)
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ ...input, sessionToken: 'rotated-token' })
      .expect(429);
    expect(limited.body.message).toContain('enter the address manually');
    expect(post).toHaveBeenCalledTimes(60);
  });

  it.each(['autocomplete', 'details'])(
    'returns a manual fallback without provider credentials or input after %s fails',
    async (method) => {
      if (method === 'details') {
        await request(app.getHttpServer())
          .post(`${prefix}/autocomplete`)
          .send(input)
          .expect(201);
      }
      const failure = throwError(
        () => new Error(`provider debug: server-key ${input.input}`),
      );
      post.mockReturnValue(failure);
      get.mockReturnValue(failure);
      const response = await request(app.getHttpServer())
        .post(`${prefix}/${method}`)
        .send(method === 'details' ? selection : input)
        .expect(503);
      expect(response.body.message).toContain('enter the address manually');
      expect(response.text).not.toContain('server-key');
      expect(response.text).not.toContain(input.input);
    },
  );
});

describe('Registration Places session and usage limits', () => {
  let places: { autocomplete: jest.Mock; details: jest.Mock };
  let service: RegistrationPlacesService;
  let now: number;

  beforeEach(() => {
    now = Date.UTC(2026, 9, 16);
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    places = {
      autocomplete: jest.fn().mockResolvedValue({ suggestions: [suggestion] }),
      details: jest.fn().mockResolvedValue(address),
    };
    service = new RegistrationPlacesService(
      places as unknown as GooglePlacesService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('binds suggestions to the requester IP as well as the session token', async () => {
    await service.autocomplete('192.0.2.1', input);
    await expect(service.details('192.0.2.2', selection)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      service.autocomplete('192.0.2.2', input),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(places.autocomplete).toHaveBeenCalledTimes(1);
    expect(places.details).not.toHaveBeenCalled();
    await expect(service.details('192.0.2.1', selection)).resolves.toEqual(
      address,
    );
  });

  it('expires selections after ten minutes and requires a new search', async () => {
    await service.autocomplete('192.0.2.1', input);
    now += 10 * 60_000;
    await expect(service.details('192.0.2.1', selection)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    expect(places.details).not.toHaveBeenCalled();
    await service.autocomplete('192.0.2.1', input);
    await expect(service.details('192.0.2.1', selection)).resolves.toEqual(
      address,
    );
  });

  it('limits one search session without preventing a selected result from resolving', async () => {
    for (let i = 0; i < 30; i++) {
      await service.autocomplete('192.0.2.1', input);
    }
    await expect(
      service.autocomplete('192.0.2.1', input),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(places.autocomplete).toHaveBeenCalledTimes(30);
    await expect(service.details('192.0.2.1', selection)).resolves.toEqual(
      address,
    );
  });

  it('keeps an hourly IP budget after minute windows reset, then recovers', async () => {
    for (let minute = 0; minute < 4; minute++) {
      for (let i = 0; i < 60; i++) {
        await service.autocomplete('192.0.2.1', {
          ...input,
          sessionToken: `${minute}-${i}`,
        });
      }
      now += 60_000;
    }
    await expect(
      service.autocomplete('192.0.2.1', {
        ...input,
        sessionToken: 'new-token',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(places.autocomplete).toHaveBeenCalledTimes(240);
    await service.autocomplete('192.0.2.2', input);
    now += 60 * 60_000;
    await service.autocomplete('192.0.2.1', input);
    expect(places.autocomplete).toHaveBeenCalledTimes(242);
  });

  it('reserves a details lookup before awaiting Google and does not reopen from a late search', async () => {
    await service.autocomplete('192.0.2.1', input);
    let finishSearch: (result: { suggestions: (typeof suggestion)[] }) => void;
    places.autocomplete.mockImplementationOnce(
      () => new Promise((resolve) => (finishSearch = resolve)),
    );
    const lateSearch = service.autocomplete('192.0.2.1', input);
    let finishDetails: (result: typeof address) => void;
    places.details.mockImplementationOnce(
      () => new Promise((resolve) => (finishDetails = resolve)),
    );
    const pendingDetails = service.details('192.0.2.1', selection);
    await expect(service.details('192.0.2.1', selection)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    finishSearch({ suggestions: [suggestion] });
    await lateSearch;
    await expect(service.details('192.0.2.1', selection)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    finishDetails(address);
    await expect(pendingDetails).resolves.toEqual(address);
    expect(places.details).toHaveBeenCalledTimes(1);
  });
});

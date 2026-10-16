import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { of, throwError } from 'rxjs';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import {
  PlaceDetailsDto,
  PlacesAutocompleteDto,
} from './dto/google-places.dto';
import { GooglePlacesController } from './google-places.controller';
import { GooglePlacesService } from './google-places.service';

const sessionToken = '94b150ba-d2e1-4da9-9839-b79907be4184';
const placeId = 'ChIJ_example-place';
const component = (type: string, longText: string, shortText = longText) => ({
  longText,
  shortText,
  types: [type],
});
const address = () => [
  component('street_number', '123'),
  component('route', 'Example Street', 'Example St'),
  component('locality', 'El Portal'),
  component('administrative_area_level_2', 'Miami-Dade County'),
  component('administrative_area_level_1', 'Florida', 'FL'),
  component('postal_code', '33138'),
  component('country', 'United States', 'US'),
];

describe('Google Places address lookup', () => {
  let post: jest.Mock;
  let get: jest.Mock;
  let configGet: jest.Mock;
  let service: GooglePlacesService;

  beforeEach(() => {
    post = jest.fn();
    get = jest.fn();
    configGet = jest.fn((key: string) =>
      key === 'GOOGLE_ROUTES_API_KEY' ? 'server-only-key' : undefined,
    );
    service = new GooglePlacesService(
      { post, get } as unknown as HttpService,
      { get: configGet } as unknown as ConfigService,
    );
  });

  it('requests US predictions with a session and returns only suggestion fields', async () => {
    post.mockReturnValue(
      of({
        data: {
          suggestions: [
            {
              placePrediction: {
                placeId,
                text: { text: '123 Example St, El Portal, FL, USA' },
                structuredFormat: {
                  mainText: { text: '123 Example St' },
                  secondaryText: { text: 'El Portal, FL, USA' },
                },
                otherGoogleField: 'not returned',
              },
            },
            { queryPrediction: { text: { text: 'unrelated search' } } },
          ],
        },
      }),
    );
    await expect(
      service.autocomplete({ input: '123 Example', sessionToken }),
    ).resolves.toEqual({
      suggestions: [
        {
          placeId,
          text: '123 Example St, El Portal, FL, USA',
          mainText: '123 Example St',
          secondaryText: 'El Portal, FL, USA',
        },
      ],
    });
    expect(post).toHaveBeenCalledWith(
      'https://places.googleapis.com/v1/places:autocomplete',
      {
        input: '123 Example',
        sessionToken,
        includedRegionCodes: ['us'],
        regionCode: 'us',
        languageCode: 'en',
        includeQueryPredictions: false,
      },
      expect.objectContaining({
        timeout: 5000,
        maxRedirects: 0,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': 'server-only-key',
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text',
        },
      }),
    );
  });

  it('returns an empty list for no matches and ignores malformed predictions', async () => {
    post.mockReturnValueOnce(of({ data: {} })).mockReturnValueOnce(
      of({
        data: {
          suggestions: [
            {
              placePrediction: { placeId: '../untrusted', text: { text: 'X' } },
            },
            { placePrediction: { placeId } },
            { placePrediction: { placeId, text: { text: 'Address' } } },
          ],
        },
      }),
    );
    await expect(
      service.autocomplete({ input: 'Unknown', sessionToken }),
    ).resolves.toEqual({ suggestions: [] });
    await expect(
      service.autocomplete({ input: 'Example', sessionToken }),
    ).resolves.toEqual({
      suggestions: [
        { placeId, text: 'Address', mainText: 'Address', secondaryText: '' },
      ],
    });
  });

  it('prefers a dedicated Places key when configured', async () => {
    configGet.mockImplementation((key: string) =>
      key === 'GOOGLE_PLACES_API_KEY' ? ' dedicated-key ' : 'routes-key',
    );
    post.mockReturnValue(of({ data: {} }));
    await service.autocomplete({ input: 'Example', sessionToken });
    expect(post.mock.calls[0][2].headers['X-Goog-Api-Key']).toBe(
      'dedicated-key',
    );
  });

  it('maps full address components without replacing the municipality with its county', async () => {
    get.mockReturnValue(of({ data: { addressComponents: address() } }));
    await expect(service.details({ placeId, sessionToken })).resolves.toEqual({
      street: '123 Example St',
      city: 'El Portal',
      state: 'FL',
      postalCode: '33138',
    });
    expect(get).toHaveBeenCalledWith(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        params: { sessionToken, languageCode: 'en', regionCode: 'us' },
        timeout: 5000,
        maxRedirects: 0,
        headers: {
          'X-Goog-Api-Key': 'server-only-key',
          'X-Goog-FieldMask': 'addressComponents',
        },
      },
    );
  });

  it('preserves a unit and normalizes ZIP+4 to the existing ZIP5 field', async () => {
    get.mockReturnValue(
      of({
        data: {
          addressComponents: [
            ...address().filter((part) => !part.types.includes('postal_code')),
            component('subpremise', '4B'),
            component('postal_code', '33138-1234'),
          ],
        },
      }),
    );
    await expect(
      service.details({ placeId, sessionToken }),
    ).resolves.toMatchObject({
      street: '123 Example St #4B',
      postalCode: '33138',
    });
  });

  it.each(['postal_town', 'sublocality_level_1', 'sublocality'])(
    'uses %s only when locality is absent',
    async (type) => {
      get.mockReturnValue(
        of({
          data: {
            addressComponents: [
              ...address().filter((part) => !part.types.includes('locality')),
              component(type, 'Example Municipality'),
            ],
          },
        }),
      );
      await expect(
        service.details({ placeId, sessionToken }),
      ).resolves.toMatchObject({ city: 'Example Municipality' });
    },
  );

  it.each([
    'street_number',
    'route',
    'locality',
    'administrative_area_level_1',
    'postal_code',
    'country',
  ])(
    'requires %s instead of guessing or filling an incomplete address',
    async (type) => {
      get.mockReturnValue(
        of({
          data: {
            addressComponents: address().filter(
              (part) => !part.types.includes(type),
            ),
          },
        }),
      );
      await expect(
        service.details({ placeId, sessionToken }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rejects a non-US address even when its postal format looks compatible', async () => {
    get.mockReturnValue(
      of({
        data: {
          addressComponents: [
            ...address().filter((part) => !part.types.includes('country')),
            component('country', 'Other Country', 'XX'),
          ],
        },
      }),
    );
    await expect(
      service.details({ placeId, sessionToken }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['autocomplete', 'details'] as const)(
    'keeps %s usable as a manual-entry fallback when the key is missing',
    async (method) => {
      configGet.mockReturnValue(undefined);
      await expect(
        service[method]({ input: '123 Example', placeId, sessionToken }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(post).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(['autocomplete', 'details'] as const)(
    'does not expose provider errors, keys or addresses from failed %s requests',
    async (method) => {
      const failure = new Error(
        'Google rejected server-only-key and 123 Example St',
      );
      post.mockReturnValue(throwError(() => failure));
      get.mockReturnValue(throwError(() => failure));
      await expect(
        service[method]({ input: '123 Example', placeId, sessionToken }),
      ).rejects.toThrow(
        'Address suggestions are temporarily unavailable. You can enter the address manually.',
      );
    },
  );
});

describe('Google Places request validation and authentication', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    transformOptions: { enableImplicitConversion: true },
  });

  it('trims input and strips fields that could change the Google endpoint or region', async () => {
    await expect(
      pipe.transform(
        {
          input: '  123 Example  ',
          sessionToken,
          url: 'https://example.test',
          includedRegionCodes: ['xx'],
        },
        { type: 'body', metatype: PlacesAutocompleteDto },
      ),
    ).resolves.toEqual({ input: '123 Example', sessionToken });
  });

  it.each(['', '12', ' '.repeat(5), 'x'.repeat(201)])(
    'rejects a short or oversized input: %p',
    async (input) => {
      await expect(
        pipe.transform(
          { input, sessionToken },
          { type: 'body', metatype: PlacesAutocompleteDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['', 'x'.repeat(37), 'token with spaces', 'token/unsafe', undefined])(
    'rejects invalid session tokens: %p',
    async (token) => {
      await expect(
        pipe.transform(
          { input: '123 Example', sessionToken: token },
          { type: 'body', metatype: PlacesAutocompleteDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform(
          { placeId, sessionToken: token },
          { type: 'body', metatype: PlaceDetailsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['', '../other', 'https://example.test', 'x'.repeat(513), undefined])(
    'rejects unsafe or oversized place IDs: %p',
    async (id) => {
      await expect(
        pipe.transform(
          { placeId: id, sessionToken },
          { type: 'body', metatype: PlaceDetailsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['autocomplete', 'details'] as const)(
    'keeps %s behind the global JWT guard',
    async (method) => {
      const handler = GooglePlacesController.prototype[method];
      const reflector = new Reflector();
      expect(
        reflector.getAllAndOverride(IS_PUBLIC_KEY, [
          handler,
          GooglePlacesController,
        ]),
      ).not.toBe(true);
      const context = {
        getHandler: () => handler,
        getClass: () => GooglePlacesController,
      } as unknown as ExecutionContext;
      const passportCheck = jest
        .spyOn(AuthGuard('jwt').prototype, 'canActivate')
        .mockRejectedValueOnce(new UnauthorizedException());
      try {
        await expect(
          new JwtAuthGuard(reflector).canActivate(context),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(passportCheck).toHaveBeenCalledWith(context);
      } finally {
        passportCheck.mockRestore();
      }
    },
  );
});

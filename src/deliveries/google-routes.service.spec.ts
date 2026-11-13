import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import { GoogleRoutesService } from './google-routes.service';

describe('GoogleRoutesService', () => {
  it('routes to the validated place ID instead of the typed address', async () => {
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          routes: [{ distanceMeters: 37208, duration: '1800s' }],
        },
      }),
    );
    const service = new GoogleRoutesService(
      { post } as unknown as HttpService,
      {
        get: jest.fn().mockReturnValue('backend-api-key'),
      } as unknown as ConfigService,
    );

    await expect(
      service.calculateDrivingRoute(
        {
          street: '100 Company St',
          addressLine2: 'Private warehouse loading dock',
          city: 'Miami',
          state: 'FL',
          postalCode: '33101',
        },
        {
          street: '7415 SW 153rd Ct',
          addressLine2: 'Private apartment 108',
          city: 'Miami',
          state: 'FL',
          postalCode: '33193',
          placeId: 'verified-place-id',
        },
      ),
    ).resolves.toEqual({
      provider: 'GOOGLE_ROUTES',
      distanceMeters: 37208,
      duration: '1800s',
    });

    expect(post.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        origin: { address: '100 Company St, Miami, FL 33101' },
        destination: { placeId: 'verified-place-id' },
      }),
    );
    expect(post.mock.calls[0][1].destination).not.toHaveProperty('address');
    expect(JSON.stringify(post.mock.calls[0][1])).not.toMatch(/Private|apartment|loading dock|addressLine2/);
  });
});

describe('Confirmed delivery route locations', () => {
  const origin = { street: '100 Company St', city: 'Miami', state: 'FL', postalCode: '33101' };
  const destination = { ...origin, street: '1603 SW 20th Terrace', placeId: 'verified-anchor' };
  const post = jest.fn();
  const service = new GoogleRoutesService(
    { post } as unknown as HttpService,
    { get: jest.fn().mockReturnValue('backend-api-key') } as unknown as ConfigService,
  );
  beforeEach(() => post.mockReset());

  it('routes to the confirmed point instead of the provider anchor or typed text', async () => {
    post.mockReturnValue(of({ data: { routes: [{ distanceMeters: 12000 }] } }));
    await service.calculateDrivingRoute(origin, { ...destination, confirmedLocation: { lat: 25.75, lng: -80.22 } });
    expect(post.mock.calls[0][1].destination).toEqual({ location: { latLng: { latitude: 25.75, longitude: -80.22 } } });
    expect(post.mock.calls[0][1].destination).not.toHaveProperty('placeId');
  });

  it.each([null, {}, { lat: '25', lng: -80 }, { lat: NaN, lng: 0 },
    { lat: 0, lng: Infinity }, { lat: -91, lng: 0 }, { lat: 0, lng: 181 }])(
    'rejects invalid route coordinates before calling the provider: %j', async confirmedLocation => {
      await expect(service.calculateDrivingRoute(origin, { ...destination, confirmedLocation: confirmedLocation as any })).rejects.toBeInstanceOf(BadRequestException);
      expect(post).not.toHaveBeenCalled();
    },
  );
});

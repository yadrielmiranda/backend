import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
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
          city: 'Miami',
          state: 'FL',
          postalCode: '33101',
        },
        {
          street: '7415 SW 153rd Ct',
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
        destination: { placeId: 'verified-place-id' },
      }),
    );
    expect(post.mock.calls[0][1].destination).not.toHaveProperty('address');
  });
});

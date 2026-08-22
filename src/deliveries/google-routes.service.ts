import { BadRequestException, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export type DeliveryRouteAddress = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
};

type GoogleRoutesResponse = {
  routes?: Array<{ distanceMeters?: number; duration?: string }>;
};

const formatAddress = (address: DeliveryRouteAddress) =>
  `${address.street}, ${address.city}, ${address.state} ${address.postalCode}`;

@Injectable()
export class GoogleRoutesService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async calculateDrivingRoute(
    origin: DeliveryRouteAddress,
    destination: DeliveryRouteAddress,
  ) {
    const apiKey = this.config.get<string>('GOOGLE_ROUTES_API_KEY')?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        'GOOGLE_ROUTES_API_KEY is not configured on the backend.',
      );
    }

    try {
      const response = await firstValueFrom(
        this.http.post<GoogleRoutesResponse>(
          'https://routes.googleapis.com/directions/v2:computeRoutes',
          {
            origin: { address: formatAddress(origin) },
            destination: { address: formatAddress(destination) },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_UNAWARE',
            computeAlternativeRoutes: false,
            languageCode: 'en-US',
            units: 'IMPERIAL',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
            },
          },
        ),
      );
      const route = response.data.routes?.[0];
      if (
        !route ||
        !Number.isInteger(route.distanceMeters) ||
        Number(route.distanceMeters) < 0
      ) {
        throw new Error('No usable route was returned.');
      }
      return {
        provider: 'GOOGLE_ROUTES',
        distanceMeters: Number(route.distanceMeters),
        duration: route.duration ?? null,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `Google Routes could not calculate a driving route between the company and delivery addresses. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      );
    }
  }
}

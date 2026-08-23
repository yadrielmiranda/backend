import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export type DeliveryRouteAddress = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
};

export type DeliveryRouteDestination = DeliveryRouteAddress & {
  placeId: string;
};

type GoogleRoutesResponse = {
  routes?: Array<{ distanceMeters?: number; duration?: string }>;
};

const formatAddress = (address: DeliveryRouteAddress) =>
  `${address.street}, ${address.city}, ${address.state} ${address.postalCode}`;

@Injectable()
export class GoogleRoutesService {
  private readonly logger = new Logger(GoogleRoutesService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async calculateDrivingRoute(
    origin: DeliveryRouteAddress,
    destination: DeliveryRouteDestination,
  ) {
    const apiKey = this.config.get<string>('GOOGLE_ROUTES_API_KEY')?.trim();
    if (!apiKey) {
      this.logger.error('GOOGLE_ROUTES_API_KEY is not configured.');
      throw new BadRequestException(
        'Delivery route calculation is temporarily unavailable. Please contact support.',
      );
    }

    try {
      const response = await firstValueFrom(
        this.http.post<GoogleRoutesResponse>(
          'https://routes.googleapis.com/directions/v2:computeRoutes',
          {
            origin: { address: formatAddress(origin) },
            destination: { placeId: destination.placeId },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_UNAWARE',
            computeAlternativeRoutes: false,
            languageCode: 'en-US',
            units: 'IMPERIAL',
          },
          {
            timeout: 10_000,
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
      this.logger.error(
        `Google Routes request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException(
        'A driving route could not be calculated for the verified delivery address. Please contact support.',
      );
    }
  }
}

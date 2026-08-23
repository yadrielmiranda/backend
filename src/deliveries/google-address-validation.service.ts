import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { DeliveryRouteAddress } from './google-routes.service';

type GoogleAddressValidationResponse = {
  result?: {
    verdict?: {
      validationGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
      hasSpellCorrectedComponents?: boolean;
      possibleNextAction?: string;
    };
    address?: {
      formattedAddress?: string;
      missingComponentTypes?: string[];
      unconfirmedComponentTypes?: string[];
      unresolvedTokens?: string[];
    };
    geocode?: {
      placeId?: string;
    };
    uspsData?: {
      dpvConfirmation?: string;
    };
  };
};

export type ValidatedDeliveryAddress = DeliveryRouteAddress & {
  placeId: string;
};

const acceptedGranularities = new Set(['PREMISE', 'SUB_PREMISE']);
const reviewActions = new Set(['FIX', 'CONFIRM', 'CONFIRM_ADD_SUBPREMISES']);
const missingStreetComponents = new Set(['street_number', 'route']);

@Injectable()
export class GoogleAddressValidationService {
  private readonly logger = new Logger(GoogleAddressValidationService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async validateDeliveryAddress(
    input: DeliveryRouteAddress,
  ): Promise<ValidatedDeliveryAddress> {
    const apiKey = this.config.get<string>('GOOGLE_ROUTES_API_KEY')?.trim();
    if (!apiKey) {
      this.logger.error('GOOGLE_ROUTES_API_KEY is not configured.');
      throw new ServiceUnavailableException(
        'Delivery address verification is temporarily unavailable. Please contact support.',
      );
    }

    let data: GoogleAddressValidationResponse;
    try {
      const response = await firstValueFrom(
        this.http.post<GoogleAddressValidationResponse>(
          'https://addressvalidation.googleapis.com/v1:validateAddress',
          {
            address: {
              regionCode: 'US',
              administrativeArea: input.state,
              locality: input.city,
              postalCode: input.postalCode,
              addressLines: [input.street],
            },
          },
          {
            timeout: 10_000,
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
            },
          },
        ),
      );
      data = response.data;
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      this.logger.error(
        `Google Address Validation request failed${status ? ` with status ${status}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Delivery address verification is temporarily unavailable. Please try again or contact support.',
      );
    }

    const result = data.result;
    const verdict = result?.verdict;
    const address = result?.address;
    if (!result || !verdict || !address) {
      this.logger.error(
        'Google Address Validation returned an incomplete response.',
      );
      throw new ServiceUnavailableException(
        'Delivery address verification is temporarily unavailable. Please try again or contact support.',
      );
    }
    const placeId = result?.geocode?.placeId?.trim();
    const missing = address?.missingComponentTypes ?? [];
    const unconfirmed = address?.unconfirmedComponentTypes ?? [];
    const unresolved = address?.unresolvedTokens ?? [];
    const dpvConfirmation = result?.uspsData?.dpvConfirmation;

    const needsUnit =
      missing.includes('subpremise') ||
      unconfirmed.includes('subpremise') ||
      dpvConfirmation === 'D' ||
      dpvConfirmation === 'S' ||
      verdict?.possibleNextAction === 'CONFIRM_ADD_SUBPREMISES';
    const missingStreet = missing.some((component) =>
      missingStreetComponents.has(component),
    );
    const hasReviewSignal = Boolean(
      !verdict?.addressComplete ||
        !acceptedGranularities.has(verdict.validationGranularity ?? '') ||
        verdict.hasUnconfirmedComponents ||
        verdict.hasInferredComponents ||
        verdict.hasReplacedComponents ||
        verdict.hasSpellCorrectedComponents ||
        reviewActions.has(verdict.possibleNextAction ?? '') ||
        missing.length ||
        unconfirmed.length ||
        unresolved.length ||
        dpvConfirmation === 'N' ||
        !placeId,
    );

    if (hasReviewSignal) {
      if (needsUnit) {
        throw new BadRequestException(
          'Add or correct the apartment, suite, or unit number and try again.',
        );
      }
      if (missingStreet) {
        throw new BadRequestException(
          'Enter a complete street address, including the street number, and try again.',
        );
      }
      throw new BadRequestException(
        'We could not verify the address exactly as entered. Check the street, city, state, and ZIP code and try again.',
      );
    }

    return { ...input, placeId };
  }
}

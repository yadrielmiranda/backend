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
      inputGranularity?: string;
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
      addressComponents?: Array<{
        componentType?: string;
        confirmationLevel?: string;
        inferred?: boolean;
        replaced?: boolean;
        spellCorrected?: boolean;
        unexpected?: boolean;
      }>;
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
const missingStreetComponents = new Set(['street_number', 'route']);
const criticalComponents = new Set([
  'street_number',
  'route',
  'locality',
  'administrative_area_level_1',
  'postal_code',
]);

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
    const components = address?.addressComponents ?? [];
    const dpvConfirmation = result?.uspsData?.dpvConfirmation;

    const unitWasEntered = verdict.inputGranularity === 'SUB_PREMISE';
    const missingStreet = missing.some((component) =>
      missingStreetComponents.has(component),
    );
    const postalCodeNeedsCorrection =
      missing.includes('postal_code') ||
      unconfirmed.includes('postal_code') ||
      components.some(
        (component) =>
          component.componentType === 'postal_code' &&
          (component.replaced === true ||
            (component.confirmationLevel !== undefined &&
              component.confirmationLevel !== 'CONFIRMED')),
      );
    const missingCoreComponent = missing.some(
      (component) => component !== 'subpremise',
    );
    const unconfirmedCoreComponent = unconfirmed.some(
      (component) =>
        criticalComponents.has(component) &&
        !(component === 'subpremise' && unitWasEntered),
    );
    const replacedCriticalComponent = components.some(
      (component) =>
        component.replaced === true &&
        criticalComponents.has(component.componentType ?? ''),
    );
    const unconfirmedCriticalComponent = components.some(
      (component) =>
        criticalComponents.has(component.componentType ?? '') &&
        component.confirmationLevel !== undefined &&
        component.confirmationLevel !== 'CONFIRMED' &&
        !(
          component.componentType === 'subpremise' &&
          unitWasEntered &&
          component.confirmationLevel === 'UNCONFIRMED_BUT_PLAUSIBLE'
        ),
    );
    const replacementDetailsMissing =
      verdict.hasReplacedComponents === true &&
      !components.some((component) => component.replaced === true);
    const unconfirmedDetailsMissing =
      verdict.hasUnconfirmedComponents === true &&
      unconfirmed.length === 0 &&
      !components.some(
        (component) =>
          component.confirmationLevel !== undefined &&
          component.confirmationLevel !== 'CONFIRMED',
      );
    const hasBlockingSignal = Boolean(
      !acceptedGranularities.has(verdict.validationGranularity ?? '') ||
        verdict.possibleNextAction === 'FIX' ||
        missingCoreComponent ||
        unconfirmedCoreComponent ||
        replacedCriticalComponent ||
        unconfirmedCriticalComponent ||
        replacementDetailsMissing ||
        unconfirmedDetailsMissing ||
        unresolved.length ||
        dpvConfirmation === 'N' ||
        !placeId,
    );

    if (hasBlockingSignal) {
      if (missingStreet) {
        throw new BadRequestException(
          'Enter a complete street address, including the street number, and try again.',
        );
      }
      if (postalCodeNeedsCorrection) {
        throw new BadRequestException(
          'The ZIP code does not match this street address. Enter the correct ZIP code and try again.',
        );
      }
      throw new BadRequestException(
        'We could not verify the address exactly as entered. Check the street, city, state, and ZIP code and try again.',
      );
    }

    return { ...input, placeId };
  }
}

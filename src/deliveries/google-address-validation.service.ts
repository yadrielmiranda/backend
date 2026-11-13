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
import { isConfirmedAddressLocation, type ConfirmedAddressLocation, type DeliveryRouteAddress } from './google-routes.service';
import { normalizeAddressLine2 } from '@/common/address-line2';

type GoogleApiErrorResponse = {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ reason?: string }>;
  };
};

type GoogleAddressValidationResponse = {
  result?: {
    verdict?: {
      inputGranularity?: string;
      validationGranularity?: string;
      geocodeGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
      hasSpellCorrectedComponents?: boolean;
      possibleNextAction?: string;
    };
    address?: {
      formattedAddress?: string;
      postalAddress?: {
        regionCode?: string;
        addressLines?: string[];
        locality?: string;
        administrativeArea?: string;
        postalCode?: string;
      };
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
      location?: { latitude?: number; longitude?: number };
    };
    uspsData?: {
      dpvConfirmation?: string;
    };
  };
};

export type ValidatedDeliveryAddress = DeliveryRouteAddress & {
  placeId: string;
};

// Only callers with a confirmation UI opt into receiving a proposed address.
// Accepting it means submitting it for validation again, never bypassing validation.
export class AddressCorrectionRequiredException extends BadRequestException {
  constructor(readonly suggestedAddress: DeliveryRouteAddress) {
    super('Confirm the suggested address before continuing.');
  }
}

export const MAX_ADDRESS_LOCATION_ADJUSTMENT_METERS = 500;
const LOCATION_DISTANCE_TOLERANCE_METERS = 1e-6;

export class AddressLocationRequiredException extends BadRequestException {
  readonly maxAdjustmentMeters = MAX_ADDRESS_LOCATION_ADJUSTMENT_METERS;

  constructor(readonly center: ConfirmedAddressLocation) {
    super({
      code: 'ADDRESS_LOCATION_CONFIRMATION_REQUIRED',
      message: 'Confirm the property location on the map before continuing.',
      center,
      maxAdjustmentMeters: MAX_ADDRESS_LOCATION_ADJUSTMENT_METERS,
    });
  }
}

function distanceMeters(a: ConfirmedAddressLocation, b: ConfirmedAddressLocation): number {
  const radians = Math.PI / 180;
  const latitude = (b.lat - a.lat) * radians;
  const longitude = (b.lng - a.lng) * radians;
  const haversine = Math.sin(latitude / 2) ** 2 +
    Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(longitude / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

const acceptedGranularities = new Set(['PREMISE', 'SUB_PREMISE']);
const missingStreetComponents = new Set(['street_number', 'route']);
const criticalComponents = new Set([
  'street_number',
  'route',
  'locality',
  'administrative_area_level_1',
  'postal_code',
]);

function correctedPostalAddress(
  input: DeliveryRouteAddress,
  result: NonNullable<GoogleAddressValidationResponse['result']>,
): DeliveryRouteAddress | null {
  const postal = result.address?.postalAddress;
  const components = result.address?.addressComponents ?? [];
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const lines = postal?.addressLines;
  if (
    text(postal?.regionCode).toUpperCase() !== 'US' ||
    !Array.isArray(lines) || !lines.length ||
    lines.some(line => !text(line) || /[\r\n]/.test(line)) ||
    !Array.from(criticalComponents).every(type => components.some(component =>
      component.componentType === type &&
      component.confirmationLevel === 'CONFIRMED' &&
      component.unexpected !== true,
    ))
  ) return null;

  const streetWasReplaced = components.some(component =>
    component.replaced === true &&
    missingStreetComponents.has(component.componentType ?? ''),
  );
  // A city/ZIP correction must not discard an apartment, floor, or other
  // delivery detail supplied by the user, even if postalAddress omits it.
  // For street corrections, only propose an unambiguous premise with no unit.
  if (streetWasReplaced && (
    result.verdict?.inputGranularity !== 'PREMISE' ||
    components.some(component => ['subpremise', 'floor', 'room'].includes(component.componentType ?? '')) ||
    /(?:#|\b(?:apt|apartment|unit|suite|ste|floor|flr|room|rm)\b)/i.test(input.street)
  )) return null;

  const suggestion = {
    street: streetWasReplaced ? lines.map(text).join(', ') : input.street.trim(),
    ...(input.addressLine2 !== undefined ? { addressLine2: normalizeAddressLine2(input.addressLine2) } : {}),
    city: text(postal?.locality),
    state: text(postal?.administrativeArea).toUpperCase(),
    postalCode: text(postal?.postalCode),
  };
  if (
    !suggestion.street || suggestion.street.length > 150 ||
    !suggestion.city || suggestion.city.length > 100 ||
    suggestion.state !== 'FL' ||
    !/^\d{5}(?:-\d{4})?$/.test(suggestion.postalCode)
  ) return null;
  const comparable = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();
  if ((['street', 'city', 'state', 'postalCode'] as const).every(key =>
    comparable(suggestion[key]) === comparable(input[key]),
  )) return null;
  return suggestion;
}

@Injectable()
export class GoogleAddressValidationService {
  private readonly logger = new Logger(GoogleAddressValidationService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async validateDeliveryAddress(
    input: DeliveryRouteAddress,
    options: { suggestCorrections?: boolean; allowLocationConfirmation?: boolean } = {},
  ): Promise<ValidatedDeliveryAddress> {
    input = { ...input, ...(input.addressLine2 !== undefined ? { addressLine2: normalizeAddressLine2(input.addressLine2) } : {}) };
    if (input.confirmedLocation !== undefined) {
      if (options.allowLocationConfirmation !== true) {
        throw new BadRequestException('Map confirmation is not available for this request.');
      }
      if (!isConfirmedAddressLocation(input.confirmedLocation)) {
        throw new BadRequestException('Select a valid location on the map.');
      }
      input.confirmedLocation = { lat: input.confirmedLocation.lat, lng: input.confirmedLocation.lng };
    }
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
      const response = isAxiosError<GoogleApiErrorResponse>(error)
        ? error.response
        : undefined;
      const status = response?.status;
      const providerError = response?.data?.error;
      const reasons = Array.isArray(providerError?.details)
        ? providerError.details.map((detail) => detail?.reason)
        : [];
      const description =
        [providerError?.status, ...reasons, providerError?.message]
          .filter((value) => typeof value === 'string' && value.trim())
          .join(' | ') ||
        (error instanceof Error ? error.message : String(error));
      // Registrar el motivo de Google sin exponer la clave ni la solicitud.
      const safeDescription = description
        .split(apiKey)
        .join('[REDACTED]')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 3_000);
      this.logger.error(
        `Google Address Validation request failed${status ? ` with status ${status}` : ''}: ${safeDescription}`,
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
    const candidateLocation = {
      lat: result.geocode?.location?.latitude,
      lng: result.geocode?.location?.longitude,
    };
    const anchor = isConfirmedAddressLocation(candidateLocation) ? candidateLocation : null;
    const locationMatchesAddress = address.postalAddress?.regionCode?.toUpperCase() === 'US' &&
      address.postalAddress.administrativeArea?.trim().toUpperCase() === input.state.trim().toUpperCase() &&
      address.postalAddress.postalCode?.slice(0, 5) === input.postalCode.trim().slice(0, 5);
    const locationHasUsefulPrecision = ['PREMISE_PROXIMITY', 'PREMISE', 'SUB_PREMISE']
      .includes(verdict.geocodeGranularity ?? '');

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
      if (
        options.suggestCorrections === true &&
        replacedCriticalComponent &&
        acceptedGranularities.has(verdict.validationGranularity ?? '') &&
        acceptedGranularities.has(verdict.geocodeGranularity ?? '') &&
        verdict.addressComplete === true &&
        verdict.possibleNextAction !== 'FIX' &&
        !missingCoreComponent && !unconfirmedCoreComponent &&
        !unconfirmedCriticalComponent && !replacementDetailsMissing &&
        !unconfirmedDetailsMissing && !unresolved.length &&
        dpvConfirmation !== 'N' && placeId
      ) {
        const suggestion = correctedPostalAddress(input, result);
        if (suggestion) throw new AddressCorrectionRequiredException(suggestion);
      }
      const plausibleHouseNumber = components.some(component =>
        component.componentType === 'street_number' &&
        component.confirmationLevel === 'UNCONFIRMED_BUT_PLAUSIBLE' && component.unexpected !== true);
      // A fully confirmed address can still have only an approximate property
      // position. Confirm that position explicitly, without overriding DPV N.
      const confirmedAddressNeedsPrecision = verdict.validationGranularity === 'PREMISE_PROXIMITY' &&
        dpvConfirmation !== 'N' && missing.length === 0 && unconfirmed.length === 0 &&
        !components.some(component => component.replaced === true && component.componentType !== 'postal_code') &&
        components.some(component => component.componentType === 'street_number' &&
          component.confirmationLevel === 'CONFIRMED');
      // Shared evidence for a map, including after an explicitly accepted ZIP
      // correction. A proposed correction never validates the current address.
      const hasLocationConfirmationEvidence = options.allowLocationConfirmation === true &&
        verdict.addressComplete === true &&
        ['PREMISE_PROXIMITY', 'PREMISE', 'SUB_PREMISE'].includes(verdict.validationGranularity ?? '') &&
        locationHasUsefulPrecision &&
        verdict.possibleNextAction !== 'FIX' &&
        !missingCoreComponent && !unresolved.length &&
        !replacementDetailsMissing && !unconfirmedDetailsMissing &&
        unconfirmed.every(type => type === 'street_number') &&
        (plausibleHouseNumber || confirmedAddressNeedsPrecision) &&
        components.every(component => component.unexpected !== true &&
          (component.confirmationLevel === undefined || component.confirmationLevel === 'CONFIRMED' ||
            (component.componentType === 'street_number' && component.confirmationLevel === 'UNCONFIRMED_BUT_PLAUSIBLE'))) &&
        ['route', 'locality', 'administrative_area_level_1', 'postal_code'].every(type =>
          components.some(component => component.componentType === type && component.confirmationLevel === 'CONFIRMED')) &&
        Boolean(placeId && anchor);
      const proposedPostalCode = address.postalAddress?.postalCode?.trim();
      if (
        options.suggestCorrections === true && hasLocationConfirmationEvidence &&
        verdict.possibleNextAction === 'CONFIRM' && missing.length === 0 &&
        address.postalAddress?.regionCode?.toUpperCase() === 'US' &&
        address.postalAddress.administrativeArea?.trim().toUpperCase() === input.state.trim().toUpperCase() &&
        address.postalAddress.locality?.trim().toUpperCase() === input.city.trim().toUpperCase() &&
        proposedPostalCode && /^\d{5}(?:-\d{4})?$/.test(proposedPostalCode) &&
        proposedPostalCode.slice(0, 5) !== input.postalCode.trim().slice(0, 5) &&
        components.some(component => component.componentType === 'postal_code' && component.replaced === true) &&
        components.every(component => component.replaced !== true || component.componentType === 'postal_code')
      ) {
        // Keep the chosen street and unit, discard any old pin, and revalidate
        // the suggested ZIP before offering a map or calculating a route.
        throw new AddressCorrectionRequiredException({
          street: input.street,
          ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
          city: input.city, state: input.state, postalCode: proposedPostalCode,
        });
      }
      const canConfirmLocation = hasLocationConfirmationEvidence &&
        locationMatchesAddress && !replacedCriticalComponent;
      if (canConfirmLocation && anchor && placeId) {
        if (input.confirmedLocation &&
          distanceMeters(anchor, input.confirmedLocation) <= MAX_ADDRESS_LOCATION_ADJUSTMENT_METERS + LOCATION_DISTANCE_TOLERANCE_METERS) {
          return { ...input, placeId };
        }
        throw new AddressLocationRequiredException(anchor);
      }
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

    if (input.confirmedLocation) {
      if (!anchor) {
        throw new ServiceUnavailableException('The property location could not be verified. Please try again.');
      }
      if (!locationMatchesAddress || !locationHasUsefulPrecision) {
        throw new BadRequestException('The property location could not be matched to this address. Check the address and try again.');
      }
      if (distanceMeters(anchor, input.confirmedLocation) > MAX_ADDRESS_LOCATION_ADJUSTMENT_METERS + LOCATION_DISTANCE_TOLERANCE_METERS) {
        throw new AddressLocationRequiredException(anchor);
      }
    }
    return { ...input, placeId };
  }
}

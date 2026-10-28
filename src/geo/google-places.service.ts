import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  PlaceDetailsDto,
  PlacesAutocompleteDto,
} from './dto/google-places.dto';

type AutocompleteResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
};
type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};
type PlaceResponse = { addressComponents?: AddressComponent[] };

const BASE_URL = 'https://places.googleapis.com/v1/places';
const AUTOCOMPLETE_FIELDS = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text.text',
  'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
].join(',');
const UNAVAILABLE_MESSAGE =
  'Address suggestions are temporarily unavailable. You can enter the address manually.';
const INCOMPLETE_MESSAGE =
  'Select a complete US street address or enter the address manually.';
const incompleteAddress = () =>
  new BadRequestException({
    code: 'ADDRESS_SUGGESTION_INCOMPLETE',
    message: INCOMPLETE_MESSAGE,
  });

@Injectable()
export class GooglePlacesService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get apiKey(): string {
    const key =
      this.config.get<string>('GOOGLE_PLACES_API_KEY')?.trim() ||
      this.config.get<string>('GOOGLE_ROUTES_API_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    return key;
  }

  async autocomplete(input: PlacesAutocompleteDto) {
    const apiKey = this.apiKey;
    let data: AutocompleteResponse;
    try {
      const response = await firstValueFrom(
        this.http.post<AutocompleteResponse>(
          `${BASE_URL}:autocomplete`,
          {
            input: input.input,
            sessionToken: input.sessionToken,
            includedRegionCodes: ['us'],
            regionCode: 'us',
            languageCode: 'en',
            includeQueryPredictions: false,
          },
          {
            timeout: 5000,
            maxRedirects: 0,
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': AUTOCOMPLETE_FIELDS,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      data = response.data;
    } catch {
      // Provider errors can contain the input address and credential headers.
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    if (!data || (data.suggestions && !Array.isArray(data.suggestions))) {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    const suggestions = (data.suggestions ?? []).flatMap((suggestion) => {
      const prediction = suggestion?.placePrediction;
      const placeId = prediction?.placeId?.trim();
      const text = prediction?.text?.text?.trim();
      if (!placeId || !text || !/^[A-Za-z0-9_-]{1,512}$/.test(placeId)) {
        return [];
      }
      return [
        {
          placeId,
          text,
          mainText: prediction.structuredFormat?.mainText?.text?.trim() || text,
          secondaryText:
            prediction.structuredFormat?.secondaryText?.text?.trim() || '',
        },
      ];
    });
    return { suggestions };
  }

  async details(input: PlaceDetailsDto) {
    const apiKey = this.apiKey;
    let data: PlaceResponse;
    try {
      const response = await firstValueFrom(
        this.http.get<PlaceResponse>(
          `${BASE_URL}/${encodeURIComponent(input.placeId)}`,
          {
            params: {
              sessionToken: input.sessionToken,
              languageCode: 'en',
              regionCode: 'us',
            },
            timeout: 5000,
            maxRedirects: 0,
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': 'addressComponents',
            },
          },
        ),
      );
      data = response.data;
    } catch {
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    const components = data?.addressComponents;
    if (!Array.isArray(components)) {
      throw incompleteAddress();
    }
    const component = (type: string, short = false): string => {
      const value = components.find((part) => part?.types?.includes(type));
      return (short ? value?.shortText : value?.longText)?.trim() || '';
    };
    const country = component('country', true).toUpperCase();
    const number = component('street_number');
    const route = component('route', true) || component('route');
    const unit = component('subpremise');
    const city =
      component('locality') ||
      component('postal_town') ||
      component('sublocality_level_1') ||
      component('sublocality');
    const state = component('administrative_area_level_1', true).toUpperCase();
    const postalCode = component('postal_code')
      .match(/^\d{5}(?:-\d{4})?$/)?.[0]
      ?.slice(0, 5);
    if (
      country !== 'US' ||
      !number ||
      !route ||
      !city ||
      !/^[A-Z]{2}$/.test(state) ||
      !postalCode
    ) {
      throw incompleteAddress();
    }
    return {
      street: `${number} ${route}${unit ? ` #${unit}` : ''}`,
      city,
      state,
      postalCode,
    };
  }
}

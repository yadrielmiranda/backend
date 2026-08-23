import { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { GoogleAddressValidationService } from './google-address-validation.service';

describe('GoogleAddressValidationService', () => {
  const post = jest.fn();
  const service = new GoogleAddressValidationService(
    { post } as unknown as HttpService,
    {
      get: jest.fn().mockReturnValue('backend-api-key'),
    } as unknown as ConfigService,
  );

  const input = {
    street: '7415 SW 153rd Ct',
    city: 'Miami',
    state: 'FL',
    postalCode: '33193',
  };

  beforeEach(() => post.mockReset());

  it('returns the entered premise and verified place ID for an exact address', async () => {
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              validationGranularity: 'PREMISE',
              addressComplete: true,
              possibleNextAction: 'ACCEPT',
            },
            address: {
              formattedAddress: '7415 SW 153rd Ct, Miami, FL 33193, USA',
              postalAddress: {
                regionCode: 'US',
                addressLines: ['7415 SW 153rd Ct'],
                locality: 'Miami',
                administrativeArea: 'FL',
                postalCode: '33193',
              },
            },
            geocode: { placeId: 'verified-place-id' },
            uspsData: { dpvConfirmation: 'Y' },
          },
        },
      }),
    );

    await expect(service.validateDeliveryAddress(input)).resolves.toEqual({
      ...input,
      placeId: 'verified-place-id',
    });
    expect(post).toHaveBeenCalledWith(
      'https://addressvalidation.googleapis.com/v1:validateAddress',
      expect.objectContaining({
        address: expect.objectContaining({
          regionCode: 'US',
          postalCode: '33193',
          addressLines: ['7415 SW 153rd Ct'],
        }),
      }),
      expect.any(Object),
    );
  });

  it('rejects text that resolves only to a broad area', async () => {
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              validationGranularity: 'OTHER',
              addressComplete: false,
              hasUnconfirmedComponents: true,
              possibleNextAction: 'FIX',
            },
            address: {
              formattedAddress: 'Miami, FL 33172, USA',
              postalAddress: {
                locality: 'Miami',
                administrativeArea: 'FL',
                postalCode: '33172',
              },
              missingComponentTypes: ['street_number', 'route'],
              unresolvedTokens: ['fbrbe'],
            },
            geocode: { placeId: 'zip-code-place-id' },
          },
        },
      }),
    );

    await expect(
      service.validateDeliveryAddress({
        street: 'fbrbe',
        city: 'Miami',
        state: 'FL',
        postalCode: '33172',
      }),
    ).rejects.toThrow(
      'Enter a complete street address, including the street number',
    );
  });

  it('requires the customer to correct an address that was changed', async () => {
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              validationGranularity: 'PREMISE',
              addressComplete: true,
              hasReplacedComponents: true,
              possibleNextAction: 'CONFIRM',
            },
            address: {
              formattedAddress: '100 Corrected St, Miami, FL 33172, USA',
              postalAddress: {
                addressLines: ['100 Corrected St'],
                locality: 'Miami',
                administrativeArea: 'FL',
                postalCode: '33172',
              },
            },
            geocode: { placeId: 'corrected-place-id' },
          },
        },
      }),
    );

    await expect(service.validateDeliveryAddress(input)).rejects.toThrow(
      'We could not verify the address exactly as entered',
    );
  });

  it('asks for a missing apartment or unit number', async () => {
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              validationGranularity: 'PREMISE',
              addressComplete: false,
              possibleNextAction: 'CONFIRM_ADD_SUBPREMISES',
            },
            address: {
              formattedAddress: '200 Apartment Way, Miami, FL 33172, USA',
              missingComponentTypes: ['subpremise'],
            },
            geocode: { placeId: 'apartment-place-id' },
            uspsData: { dpvConfirmation: 'D' },
          },
        },
      }),
    );

    await expect(service.validateDeliveryAddress(input)).rejects.toThrow(
      'Add or correct the apartment, suite, or unit number',
    );
  });

  it('treats an incomplete provider response as unavailable', async () => {
    post.mockReturnValue(of({ data: {} }));

    await expect(service.validateDeliveryAddress(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

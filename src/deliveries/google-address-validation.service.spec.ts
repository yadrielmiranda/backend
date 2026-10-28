import { HttpService } from '@nestjs/axios';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import {
  AddressCorrectionRequiredException,
  GoogleAddressValidationService,
} from './google-address-validation.service';

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

  it('identifies a ZIP code that Google replaced', async () => {
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
              addressComponents: [
                {
                  componentType: 'postal_code',
                  confirmationLevel: 'CONFIRMED',
                  replaced: true,
                },
              ],
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
      'The ZIP code does not match this street address',
    );
  });

  it('accepts a verified building address when apartment or unit is omitted', async () => {
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              inputGranularity: 'PREMISE',
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

    await expect(service.validateDeliveryAddress(input)).resolves.toEqual({
      ...input,
      placeId: 'apartment-place-id',
    });
  });

  it('reports the wrong ZIP before an optional missing apartment', async () => {
    const wrongZipInput = { ...input, postalCode: '33172' };
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              inputGranularity: 'PREMISE',
              validationGranularity: 'PREMISE',
              addressComplete: false,
              hasReplacedComponents: true,
              possibleNextAction: 'CONFIRM_ADD_SUBPREMISES',
            },
            address: {
              formattedAddress: '7415 SW 153rd Ct, Miami, FL 33193, USA',
              missingComponentTypes: ['subpremise'],
              addressComponents: [
                {
                  componentType: 'postal_code',
                  confirmationLevel: 'CONFIRMED',
                  replaced: true,
                },
              ],
            },
            geocode: { placeId: 'apartment-place-id' },
            uspsData: { dpvConfirmation: 'D' },
          },
        },
      }),
    );

    await expect(
      service.validateDeliveryAddress(wrongZipInput),
    ).rejects.toThrow('The ZIP code does not match this street address');
  });

  it('accepts a valid premise when the entered apartment is only normalized', async () => {
    const apartmentInput = {
      street: '7415 Southwest 153rd Court apt 108',
      city: 'Miami',
      state: 'FL',
      postalCode: '33193',
    };
    post.mockReturnValue(
      of({
        data: {
          result: {
            verdict: {
              inputGranularity: 'SUB_PREMISE',
              validationGranularity: 'PREMISE',
              addressComplete: true,
              hasUnconfirmedComponents: true,
              hasInferredComponents: true,
              hasSpellCorrectedComponents: true,
              possibleNextAction: 'CONFIRM',
            },
            address: {
              formattedAddress:
                '7415 SW 153rd Ct Apt 108, Miami, FL 33193, USA',
              unconfirmedComponentTypes: ['subpremise'],
              addressComponents: [
                {
                  componentType: 'street_number',
                  confirmationLevel: 'CONFIRMED',
                },
                {
                  componentType: 'route',
                  confirmationLevel: 'CONFIRMED',
                  spellCorrected: true,
                },
                {
                  componentType: 'subpremise',
                  confirmationLevel: 'UNCONFIRMED_BUT_PLAUSIBLE',
                },
                {
                  componentType: 'postal_code',
                  confirmationLevel: 'CONFIRMED',
                },
              ],
            },
            geocode: { placeId: 'verified-apartment-building' },
          },
        },
      }),
    );

    await expect(
      service.validateDeliveryAddress(apartmentInput),
    ).resolves.toEqual({
      ...apartmentInput,
      placeId: 'verified-apartment-building',
    });
  });

  it('treats an incomplete provider response as unavailable', async () => {
    post.mockReturnValue(of({ data: {} }));

    await expect(service.validateDeliveryAddress(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('address correction confirmation', () => {
    const entered = {
      street: '1307 SW 57th Ave', city: 'West Miami', state: 'FL', postalCode: '33144',
    };
    const corrected = {
      ...entered, city: 'Coral Gables', postalCode: '33144-5717',
    };
    // Based on the provider response for the reported West Miami address.
    function correctedResult(): any {
      return {
        verdict: {
          inputGranularity: 'PREMISE', validationGranularity: 'PREMISE',
          geocodeGranularity: 'SUB_PREMISE', addressComplete: true,
          hasReplacedComponents: true, possibleNextAction: 'CONFIRM',
        },
        address: {
          postalAddress: {
            regionCode: 'US', addressLines: ['1307 SW 57th Ave'],
            locality: 'Coral Gables', administrativeArea: 'FL', postalCode: '33144-5717',
          },
          addressComponents: ['street_number', 'route', 'locality', 'administrative_area_level_1', 'postal_code'].map(type => ({
            componentType: type, confirmationLevel: 'CONFIRMED',
            ...(type === 'locality' ? { replaced: true } : {}),
          })),
        },
        geocode: { placeId: 'verified-property' },
        uspsData: { dpvConfirmation: 'Y' },
      };
    }
    function respond(result = correctedResult()) {
      post.mockReturnValue(of({ data: { result } }));
    }

    it('offers a fully verified corrected city only to callers supporting confirmation', async () => {
      respond();
      const error = await service.validateDeliveryAddress(entered, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
      expect(error.suggestedAddress).toEqual(corrected);
      expect(Object.keys(error.suggestedAddress).sort()).toEqual(['city', 'postalCode', 'state', 'street']);
      await expect(service.validateDeliveryAddress(entered)).rejects.toThrow('We could not verify the address exactly as entered');
    });

    it('revalidates the confirmed correction through Google before accepting it', async () => {
      respond();
      const error = await service.validateDeliveryAddress(entered, { suggestCorrections: true }).catch(error => error);
      const confirmedResult = correctedResult();
      confirmedResult.verdict.hasReplacedComponents = false;
      confirmedResult.verdict.possibleNextAction = 'ACCEPT';
      confirmedResult.address.addressComponents.forEach(component => delete component.replaced);
      respond(confirmedResult);
      await expect(service.validateDeliveryAddress(error.suggestedAddress, { suggestCorrections: true })).resolves.toEqual({
        ...corrected, placeId: 'verified-property',
      });
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[1][1].address).toEqual({
        regionCode: 'US', administrativeArea: 'FL', locality: 'Coral Gables',
        postalCode: '33144-5717', addressLines: ['1307 SW 57th Ave'],
      });
    });

    it('preserves an entered apartment when the provider corrects the city but omits it from postal lines', async () => {
      const result = correctedResult();
      result.verdict.inputGranularity = 'SUB_PREMISE';
      respond(result);
      const unitAddress = { ...entered, street: '1307 SW 57th Ave Apt 108' };
      const error = await service.validateDeliveryAddress(unitAddress, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
      expect(error.suggestedAddress.street).toBe(unitAddress.street);
    });

    it('offers a corrected street only for a confirmed premise without an entered unit', async () => {
      const result = correctedResult();
      result.address.addressComponents[0].replaced = true;
      respond(result);
      const error = await service.validateDeliveryAddress({ ...entered, street: '1309 SW 57th Ave' }, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
      expect(error.suggestedAddress.street).toBe('1307 SW 57th Ave');

      result.verdict.inputGranularity = 'SUB_PREMISE';
      const unitError = await service.validateDeliveryAddress({ ...entered, street: '1309 SW 57th Ave #108' }, { suggestCorrections: true }).catch(error => error);
      expect(unitError).toBeInstanceOf(BadRequestException);
      expect(unitError).not.toBeInstanceOf(AddressCorrectionRequiredException);
    });

    it.each([
      ['an unconfirmed street number', (r: any) => { r.address.addressComponents[0].confirmationLevel = 'UNCONFIRMED_BUT_PLAUSIBLE'; }],
      ['a missing street number', (r: any) => { r.address.missingComponentTypes = ['street_number']; }],
      ['an unresolved token', (r: any) => { r.address.unresolvedTokens = ['unknown']; }],
      ['a FIX verdict', (r: any) => { r.verdict.possibleNextAction = 'FIX'; }],
      ['a broad geocode', (r: any) => { r.verdict.geocodeGranularity = 'ROUTE'; }],
      ['an incomplete address', (r: any) => { r.verdict.addressComplete = false; }],
      ['a non-deliverable address', (r: any) => { r.uspsData.dpvConfirmation = 'N'; }],
      ['a missing place ID', (r: any) => { delete r.geocode.placeId; }],
      ['missing confirmation evidence', (r: any) => { r.address.addressComponents = r.address.addressComponents.filter(c => c.componentType !== 'route'); }],
      ['missing postal data', (r: any) => { delete r.address.postalAddress; }],
      ['malformed postal lines', (r: any) => { r.address.postalAddress.addressLines = [null]; }],
      ['a malformed city', (r: any) => { r.address.postalAddress.locality = { value: 'Coral Gables' }; }],
      ['an invalid ZIP', (r: any) => { r.address.postalAddress.postalCode = '3314'; }],
      ['an out-of-state correction', (r: any) => { r.address.postalAddress.administrativeArea = 'GA'; }],
      ['a foreign address', (r: any) => { r.address.postalAddress.regionCode = 'CA'; }],
    ])('does not suggest a correction with %s', async (_label, mutate) => {
      const result = correctedResult();
      mutate(result);
      respond(result);
      const error = await service.validateDeliveryAddress(entered, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(AddressCorrectionRequiredException);
    });

    it('does not propose the already entered address again', async () => {
      respond();
      const error = await service.validateDeliveryAddress(corrected, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(AddressCorrectionRequiredException);
    });
  });
});

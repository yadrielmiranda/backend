import { HttpService } from '@nestjs/axios';
import { BadRequestException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import {
  AddressCorrectionRequiredException,
  AddressLocationRequiredException,
  GoogleAddressValidationService,
} from './google-address-validation.service';
import { AddressConfirmationsController } from './address-confirmations.controller';
import { AddressConfirmationReviewDto } from './dto/address-confirmation.dto';

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

    await expect(service.validateDeliveryAddress({ ...input, addressLine2: '  Apt 108, rear entrance  ' })).resolves.toEqual({
      ...input,
      addressLine2: 'Apt 108, rear entrance',
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
    expect(JSON.stringify(post.mock.calls[0][1])).not.toMatch(/Apt 108|rear entrance|addressLine2/);
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

    it('preserves a separate freeform line through correction and revalidation without sending it to Google', async () => {
      respond();
      const error = await service.validateDeliveryAddress({ ...entered, addressLine2: '  Apt 108, rear entrance  ' }, { suggestCorrections: true }).catch(error => error);
      expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
      expect(error.suggestedAddress).toEqual({ ...corrected, addressLine2: 'Apt 108, rear entrance' });
      const accepted = correctedResult();
      accepted.verdict.hasReplacedComponents = false;
      accepted.verdict.possibleNextAction = 'ACCEPT';
      accepted.address.addressComponents.forEach(component => delete component.replaced);
      respond(accepted);
      await expect(service.validateDeliveryAddress(error.suggestedAddress)).resolves.toMatchObject({
        addressLine2: 'Apt 108, rear entrance', placeId: 'verified-property',
      });
      for (const call of post.mock.calls) expect(JSON.stringify(call[1])).not.toMatch(/Apt 108|rear entrance|addressLine2/);
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

describe('Explicit property location confirmation', () => {
  const input = { street: '1603 SW 20th Terrace', city: 'Miami', state: 'FL', postalCode: '33145' };
  const center = { lat: 25.753, lng: -80.222 };
  const options = { suggestCorrections: true, allowLocationConfirmation: true };
  const post = jest.fn();
  const service = new GoogleAddressValidationService(
    { post } as unknown as HttpService,
    { get: jest.fn().mockReturnValue('backend-api-key') } as unknown as ConfigService,
  );
  function plausible(): any {
    return {
      verdict: {
        inputGranularity: 'PREMISE', validationGranularity: 'PREMISE_PROXIMITY',
        geocodeGranularity: 'PREMISE_PROXIMITY', addressComplete: true,
        hasUnconfirmedComponents: true,
      },
      address: {
        postalAddress: {
          regionCode: 'US', addressLines: [input.street], locality: input.city,
          administrativeArea: input.state, postalCode: input.postalCode,
        },
        unconfirmedComponentTypes: ['street_number'],
        addressComponents: ['street_number', 'route', 'locality', 'administrative_area_level_1', 'postal_code']
          .map(componentType => ({ componentType,
            confirmationLevel: componentType === 'street_number' ? 'UNCONFIRMED_BUT_PLAUSIBLE' : 'CONFIRMED' })),
      },
      geocode: { placeId: 'provider-anchor', location: { latitude: center.lat, longitude: center.lng } },
      uspsData: { dpvConfirmation: 'N' },
    };
  }
  function precise(): any {
    const result = plausible();
    result.verdict.validationGranularity = 'PREMISE';
    result.verdict.geocodeGranularity = 'PREMISE';
    result.verdict.hasUnconfirmedComponents = false;
    result.address.unconfirmedComponentTypes = [];
    result.address.addressComponents[0].confirmationLevel = 'CONFIRMED';
    result.uspsData.dpvConfirmation = 'Y';
    return result;
  }
  function respond(result = plausible()) { post.mockReturnValue(of({ data: { result } })); }
  beforeEach(() => post.mockReset());

  function replacedPostalCode(postalCode = input.postalCode): any {
    const result = plausible();
    result.verdict.hasReplacedComponents = true;
    result.verdict.possibleNextAction = 'CONFIRM';
    result.address.postalAddress.postalCode = postalCode;
    result.address.addressComponents.find(component => component.componentType === 'postal_code').replaced = true;
    return result;
  }

  it.each([
    ['33165', '33145'], ['33175', '33145'], ['33142', '33144'],
  ])('offers provider ZIP %s -> %s before asking for the property location', async (enteredZip, correctedZip) => {
    respond(replacedPostalCode(correctedZip));
    const entered = { ...input, postalCode: enteredZip, addressLine2: '  Apt 4B, rear entrance  ', confirmedLocation: center };
    const error = await service.validateDeliveryAddress(entered, options).catch(error => error);
    expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
    expect(error.suggestedAddress).toEqual({ ...input, postalCode: correctedZip, addressLine2: 'Apt 4B, rear entrance' });
    expect(error.suggestedAddress).not.toHaveProperty('confirmedLocation');
    expect(error.suggestedAddress).not.toHaveProperty('placeId');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(['INSTALLATION', 'DELIVERY'] as const)('revalidates ZIP acceptance and pin separately for %s', async purpose => {
    const controller = new AddressConfirmationsController(service);
    respond(replacedPostalCode());
    const first = await controller.review({ purpose, address: { ...input, postalCode: '33175' } });
    expect(first).toEqual({ status: 'CONFIRM_SUGGESTION', suggestedAddress: input });

    respond(plausible());
    const second = await controller.review({ purpose, address: first.suggestedAddress! });
    expect(second).toEqual({ status: 'CONFIRM_LOCATION', center, maxAdjustmentMeters: 500 });
    const third = await controller.review({ purpose, address: { ...first.suggestedAddress!, confirmedLocation: center } });
    expect(third).toEqual({ status: 'VALIDATED', address: { ...input, confirmedLocation: center } });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.map(call => call[1].address.postalCode)).toEqual(['33175', '33145', '33145']);
  });

  it.each([
    ['replaced street', (r: any) => { r.address.addressComponents[1].replaced = true; }],
    ['replaced city', (r: any) => { r.address.addressComponents[2].replaced = true; }],
    ['replaced country', (r: any) => { r.address.addressComponents.push({ componentType: 'country', confirmationLevel: 'CONFIRMED', replaced: true }); }],
    ['replaced unit', (r: any) => { r.address.addressComponents.push({ componentType: 'subpremise', confirmationLevel: 'CONFIRMED', replaced: true }); }],
    ['unconfirmed ZIP', (r: any) => { r.address.addressComponents[4].confirmationLevel = 'UNCONFIRMED_BUT_PLAUSIBLE'; }],
    ['invalid ZIP', (r: any) => { r.address.postalAddress.postalCode = '3314'; }],
    ['unchanged ZIP', (r: any) => { r.address.postalAddress.postalCode = '33175'; }],
    ['suspicious house number', (r: any) => { r.address.addressComponents[0].confirmationLevel = 'UNCONFIRMED_AND_SUSPICIOUS'; }],
    ['unconfirmed road', (r: any) => { r.address.addressComponents[1].confirmationLevel = 'UNCONFIRMED_BUT_PLAUSIBLE'; }],
    ['missing unit', (r: any) => { r.address.missingComponentTypes = ['subpremise']; }],
    ['unresolved text', (r: any) => { r.address.unresolvedTokens = ['unknown']; }],
    ['unexpected component', (r: any) => { r.address.addressComponents[0].unexpected = true; }],
    ['broad geocode', (r: any) => { r.verdict.geocodeGranularity = 'ROUTE'; }],
    ['FIX response', (r: any) => { r.verdict.possibleNextAction = 'FIX'; }],
    ['different city', (r: any) => { r.address.postalAddress.locality = 'Coral Gables'; }],
    ['different state', (r: any) => { r.address.postalAddress.administrativeArea = 'GA'; }],
    ['foreign location', (r: any) => { r.address.postalAddress.regionCode = 'CA'; }],
    ['no location', (r: any) => { delete r.geocode.location; }],
    ['no explicit ZIP replacement', (r: any) => { delete r.address.addressComponents[4].replaced; }],
  ])('does not propose a ZIP-and-map correction with %s', async (_label, change) => {
    const result = replacedPostalCode(); change(result); respond(result);
    const error = await service.validateDeliveryAddress({ ...input, postalCode: '33175', confirmedLocation: center }, options).catch(error => error);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(AddressCorrectionRequiredException);
    expect(error).not.toBeInstanceOf(AddressLocationRequiredException);
  });

  it.each([{}, { suggestCorrections: true }, { allowLocationConfirmation: true }])('retains strict rejection without both confirmation capabilities: %j', async capabilities => {
    respond(replacedPostalCode());
    const error = await service.validateDeliveryAddress({ ...input, postalCode: '33175' }, capabilities).catch(error => error);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(AddressCorrectionRequiredException);
  });

  it('requires an explicit map choice for the plausible house number with DPV N', async () => {
    respond();
    const error = await service.validateDeliveryAddress(input, options).catch(error => error);
    expect(error).toBeInstanceOf(AddressLocationRequiredException);
    expect(error.getResponse()).toEqual({
      code: 'ADDRESS_LOCATION_CONFIRMATION_REQUIRED', center, maxAdjustmentMeters: 500,
      message: 'Confirm the property location on the map before continuing.',
    });
    await expect(service.validateDeliveryAddress(input)).rejects.not.toBeInstanceOf(AddressLocationRequiredException);
    await expect(service.validateDeliveryAddress(input, { suggestCorrections: true })).rejects.not.toBeInstanceOf(AddressLocationRequiredException);
  });

  it('revalidates the address on every confirmation and preserves the separate detail without sending it to Google', async () => {
    respond();
    const address = { ...input, addressLine2: '  Rear building  ', confirmedLocation: { ...center, lat: center.lat + 0.001 } };
    await expect(service.validateDeliveryAddress(address, options)).resolves.toEqual({
      ...address, addressLine2: 'Rear building', placeId: 'provider-anchor',
    });
    await expect(service.validateDeliveryAddress(address, options)).resolves.toHaveProperty('confirmedLocation', address.confirmedLocation);
    expect(post).toHaveBeenCalledTimes(2);
    for (const call of post.mock.calls) expect(JSON.stringify(call[1])).not.toMatch(/Rear building|confirmedLocation|latitude|longitude/);
  });

  it('uses the current provider anchor and asks again when the selected point is farther than 500 meters', async () => {
    respond();
    const north = (meters: number) => ({ ...center, lat: center.lat + meters / 6_371_000 * 180 / Math.PI });
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(499) }, options)).resolves.toHaveProperty('placeId');
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(500) }, options)).resolves.toHaveProperty('placeId');
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(500.01) }, options)).rejects.toBeInstanceOf(AddressLocationRequiredException);
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(501) }, options)).rejects.toBeInstanceOf(AddressLocationRequiredException);
    const moved = plausible();
    moved.geocode.location.latitude += 0.02;
    respond(moved);
    const error = await service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options).catch(error => error);
    expect(error).toBeInstanceOf(AddressLocationRequiredException);
    expect(error.center.lat).toBe(moved.geocode.location.latitude);
  });

  it.each([null, {}, { lat: '25.753', lng: -80.222 }, { lat: true, lng: 0 },
    { lat: NaN, lng: 0 }, { lat: Infinity, lng: 0 }, { lat: 91, lng: 0 },
    { lat: 0, lng: -181 }, [25, -80]])('rejects malformed points before contacting Google: %j', async point => {
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: point as any }, options)).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects coordinates from callers that did not opt into map confirmation', async () => {
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: center })).rejects.toThrow('Map confirmation is not available');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['incomplete address', (r: any) => { r.verdict.addressComplete = false; }],
    ['broad validation', (r: any) => { r.verdict.validationGranularity = 'ROUTE'; }],
    ['broad geocode', (r: any) => { r.verdict.geocodeGranularity = 'ROUTE'; }],
    ['FIX verdict', (r: any) => { r.verdict.possibleNextAction = 'FIX'; }],
    ['missing street number', (r: any) => { r.address.missingComponentTypes = ['street_number']; }],
    ['unresolved text', (r: any) => { r.address.unresolvedTokens = ['unknown']; }],
    ['missing place ID', (r: any) => { delete r.geocode.placeId; }],
    ['missing anchor', (r: any) => { delete r.geocode.location; }],
    ['invalid anchor', (r: any) => { r.geocode.location.latitude = 91; }],
    ['suspicious number', (r: any) => { r.address.addressComponents[0].confirmationLevel = 'UNCONFIRMED_AND_SUSPICIOUS'; }],
    ['unconfirmed road', (r: any) => { r.address.addressComponents[1].confirmationLevel = 'UNCONFIRMED_BUT_PLAUSIBLE'; }],
    ['unconfirmed locality list', (r: any) => { r.address.unconfirmedComponentTypes.push('locality'); }],
    ['missing route confirmation', (r: any) => { r.address.addressComponents.splice(1, 1); }],
    ['replaced street', (r: any) => { r.address.addressComponents[1].replaced = true; }],
    ['unexpected number', (r: any) => { r.address.addressComponents[0].unexpected = true; }],
    ['different country', (r: any) => { r.address.postalAddress.regionCode = 'CA'; }],
    ['different state', (r: any) => { r.address.postalAddress.administrativeArea = 'GA'; }],
    ['different ZIP', (r: any) => { r.address.postalAddress.postalCode = '33101'; }],
  ])('does not allow the map to bypass %s', async (_label, change) => {
    const result = plausible(); change(result); respond(result);
    for (const confirmedLocation of [undefined, center]) {
      const error = await service.validateDeliveryAddress({ ...input, confirmedLocation }, options).catch(error => error);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(AddressLocationRequiredException);
    }
  });

  it('does not turn DPV N alone into an eligible map confirmation', async () => {
    const result = precise(); result.uspsData.dpvConfirmation = 'N'; respond(result);
    const error = await service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options).catch(error => error);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(AddressLocationRequiredException);
  });

  it('asks for a map point when all address components are confirmed but the premise precision is approximate', async () => {
    const result = precise();
    result.verdict.validationGranularity = 'PREMISE_PROXIMITY';
    result.verdict.geocodeGranularity = 'PREMISE_PROXIMITY';
    respond(result);
    await expect(service.validateDeliveryAddress(input, options)).rejects.toBeInstanceOf(AddressLocationRequiredException);
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options))
      .resolves.toHaveProperty('confirmedLocation', center);
    const strict = await service.validateDeliveryAddress(input).catch(error => error);
    expect(strict).toBeInstanceOf(BadRequestException);
    expect(strict).not.toBeInstanceOf(AddressLocationRequiredException);

    result.uspsData.dpvConfirmation = 'N'; respond(result);
    const nonDeliverable = await service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options).catch(error => error);
    expect(nonDeliverable).toBeInstanceOf(BadRequestException);
    expect(nonDeliverable).not.toBeInstanceOf(AddressLocationRequiredException);
  });

  it('retains precise legacy acceptance but validates any supplied point against its anchor', async () => {
    const result = precise(); respond(result);
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options)).resolves.toHaveProperty('confirmedLocation', center);
    const north = (meters: number) => ({ ...center, lat: center.lat + meters / 6_371_000 * 180 / Math.PI });
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(500) }, options)).resolves.toHaveProperty('placeId');
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: north(500.01) }, options)).rejects.toBeInstanceOf(AddressLocationRequiredException);
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: { ...center, lat: center.lat + 1 } }, options)).rejects.toBeInstanceOf(AddressLocationRequiredException);
    delete result.geocode.location; respond(result);
    await expect(service.validateDeliveryAddress(input)).resolves.toHaveProperty('placeId');
    await expect(service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('offers a reliable correction first and discards a pin attached to the old address', async () => {
    const result = precise();
    result.verdict.hasReplacedComponents = true;
    result.address.addressComponents[2].replaced = true;
    result.address.postalAddress.locality = 'Coral Gables';
    respond(result);
    const error = await service.validateDeliveryAddress({ ...input, confirmedLocation: center }, options).catch(error => error);
    expect(error).toBeInstanceOf(AddressCorrectionRequiredException);
    expect(error.suggestedAddress.city).toBe('Coral Gables');
    expect(error.suggestedAddress).not.toHaveProperty('confirmedLocation');
  });

  it('returns review states without leaking private place IDs or writing data', async () => {
    const controller = new AddressConfirmationsController(service);
    respond();
    await expect(controller.review({ address: input, purpose: 'INSTALLATION' })).resolves.toEqual({
      status: 'CONFIRM_LOCATION', center, maxAdjustmentMeters: 500,
    });
    const accepted = await controller.review({ address: { ...input, confirmedLocation: center }, purpose: 'DELIVERY' });
    expect(accepted).toEqual({ status: 'VALIDATED', address: { ...input, confirmedLocation: center } });
    expect(JSON.stringify(accepted)).not.toContain('placeId');
    post.mockClear();
    await expect(controller.review({ address: { ...input, state: 'GA' }, purpose: 'INSTALLATION' })).rejects.toThrow('only in Florida');
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps the review DTO strict with the production implicit conversion enabled', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } });
    const transform = (address: unknown) => pipe.transform({ purpose: 'DELIVERY', address }, { type: 'body', metatype: AddressConfirmationReviewDto });
    await expect(transform({ ...input, confirmedLocation: center })).resolves.toHaveProperty('address.confirmedLocation.lat', center.lat);
    for (const confirmedLocation of [null, { lat: '25.753', lng: -80.222 }, { lat: true, lng: -80.222 }, { lat: null, lng: -80.222 }, { lat: 91, lng: -80.222 }]) {
      await expect(transform({ ...input, confirmedLocation })).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const key of ['street', 'city', 'state', 'postalCode']) await expect(transform({ ...input, [key]: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

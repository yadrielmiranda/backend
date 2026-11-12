import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEstimateHeaderDto, UpdateEstimateHeaderDto } from './dto/estimate-header.dto';
import { CreateDeliveryDto } from '@/deliveries/dto/delivery.dto';
import { InstallationAddressDto } from '@/installation/dto/installation-address.dto';
import { installationAddress } from '@/installation/installation-address';
import { agreementContent, agreementScopes } from '@/contracts/agreement-content';
import { materialRevisionBaseHash } from './material-revisions/material-revision-snapshot';
import { EstimateAuditSnapshotBuilder } from './audit/estimate-audit-snapshot.builder';
import { buildPublicEstimateData } from './public-share/public-estimate-data';

const baseAddress = { street: '100 Main St', city: 'Miami', state: 'FL', postalCode: '33101' };

describe('Optional address details across estimate and installation boundaries', () => {
  it.each([
    [CreateEstimateHeaderDto, { name: 'Project' }, 'customerAddressLine2'],
    [UpdateEstimateHeaderDto, {}, 'customerAddressLine2'],
    [CreateDeliveryDto, {}, 'addressLine2'],
    [InstallationAddressDto, baseAddress, 'addressLine2'],
  ] as const)('validates trimmed freeform detail without making it required (%p)', async (Dto, required, field) => {
    for (const value of [undefined, null, '', '  ', '  Suite 12 – rear building  ']) {
      const dto = plainToInstance(Dto as any, { ...required, ...(value === undefined ? {} : { [field]: value }) }) as any;
      expect(await validate(dto)).toEqual([]);
      expect(dto[field]).toBe(typeof value === 'string' ? value.trim() || null : value);
    }
    for (const value of [42, { unit: '12' }, 'a'.repeat(151)]) {
      const dto = plainToInstance(Dto as any, { ...required, [field]: value }, { enableImplicitConversion: true }) as any;
      expect((await validate(dto)).length).toBeGreaterThan(0);
    }
  });

  it('preserves legacy installation snapshot shape and handles optional detail separately', () => {
    expect(installationAddress(baseAddress)).toEqual(baseAddress);
    expect(installationAddress({ ...baseAddress, addressLine2: '  Rear entrance  ', private: 'hidden' }))
      .toEqual({ ...baseAddress, addressLine2: 'Rear entrance' });
    expect(installationAddress({ ...baseAddress, addressLine2: '' })).toEqual({ ...baseAddress, addressLine2: null });
    expect(installationAddress({ ...baseAddress, addressLine2: 'a'.repeat(151) })).toBeNull();
  });

  it('includes detail in public, audit and agreement snapshots and fingerprints', () => {
    const estimate: any = { id: 1, user: { role: { name: 'dealer' }, dealerMode: 'EXTERNAL' }, pieces: [], customerStreet: baseAddress.street, customerAddressLine2: 'Suite 12' };
    const publicData = buildPublicEstimateData(estimate, null, [], 'detailed');
    expect(publicData.customerAddressLine2).toBe('Suite 12');
    expect(EstimateAuditSnapshotBuilder.build(estimate).customerAddressLine2).toBe('Suite 12');
    expect(agreementContent(publicData).header.customerAddressLine2).toBe('Suite 12');
    expect(agreementScopes(publicData).materialHash).not.toBe(agreementScopes({ ...publicData, customerAddressLine2: 'Suite 13' }).materialHash);
    expect(materialRevisionBaseHash(estimate)).not.toBe(materialRevisionBaseHash({ ...estimate, customerAddressLine2: 'Suite 13' }));
  });

  it('keeps historical agreement and revision fingerprints stable for newly added null columns', () => {
    const old = { id: 1, pieces: [], customerStreet: baseAddress.street };
    expect(agreementContent(old).header).not.toHaveProperty('customerAddressLine2');
    expect(agreementScopes(old)).toEqual(agreementScopes({ ...old, customerAddressLine2: null }));
    expect(materialRevisionBaseHash(old)).toBe(materialRevisionBaseHash({ ...old, customerAddressLine2: null }));
  });
});

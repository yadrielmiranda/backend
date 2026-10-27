import { buildPublicEstimateData } from '@/estimates/public-share/public-estimate-data';
import {
  agreementContent,
  agreementScopes,
  canonicalJson,
  sha256,
} from './agreement-content';

function legacyFixture(): any {
  return {
    id: 41,
    number: 'EST-0041',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerPriceT: '1000.00',
    customerTaxRate: '0.07',
    customerTaxAmount: '70.00',
    customerTotalPayable: '1070.00',
    pieces: [{
      qty: 2,
      idProd: 1,
      idBrand: 3,
      idSyst: 2,
      idConf: 1,
      idFC: 1,
      idCryst: 2,
      idTint: 1,
      idCoat: 2,
      idPrivacy: 1,
      width: '35',
      height: '62',
      customerPrice: '500.00',
      customerSubtotal: '1000.00',
    }],
  };
}

function energySnapshot(): any {
  return {
    schemaVersion: 1,
    status: 'AVAILABLE',
    uFactor: '1.075',
    shgc: '0.586',
    vlt: '0.674',
    units: 'Btu/(h·ft²·°F)',
    ratingId: 71,
    capturedAt: '2026-10-18T12:00:00.000Z',
    selection: { idBrand: 3, idSyst: 2, idCryst: 2 },
    source: { file: 'private-source.xlsx', sheet: 'NFRC PLAN', row: 92, version: '0.9', glassId: 'GL-17', composition: 'private-composition' },
    notes: 'private-notes',
    reason: 'private-reason',
  };
}

function contentHash(estimate: any) {
  return sha256(canonicalJson(agreementContent(estimate)));
}

describe('Garage design in agreement content', () => {
  it('preserves legacy hashes with a null pair, and detects design or color changes without a price change', () => {
    const estimate = legacyFixture();
    const originalHash = contentHash(estimate);
    Object.assign(estimate.pieces[0], { idDesign: null, idDesignColor: null, designSnapshot: null });
    expect(contentHash(estimate)).toBe(originalHash);
    Object.assign(estimate.pieces[0], { idDesign: 4, idDesignColor: 5, designSnapshot: {
      version: 1, systemId: 2,
      design: { id: 4, name: 'Solid', imageUrl: null },
      color: { id: 5, name: 'Oak', hexCode: '#995522' },
    } });
    const designedHash = contentHash(estimate);
    expect(designedHash).not.toBe(originalHash);
    estimate.pieces[0].idDesignColor = 6;
    expect(contentHash(estimate)).not.toBe(designedHash);
  });
});

describe('Energy values in agreement fingerprints', () => {
  it.each([undefined, null])('keeps historical hashes unchanged without an energy snapshot (%p)', (snapshot) => {
    const estimate = legacyFixture();
    if (snapshot === null) estimate.pieces[0].energySnapshot = null;
    expect(agreementContent(estimate).pieces[0]).not.toHaveProperty('energy');
    // Independently captured using agreement-content.ts before energy integration,
    // commit 7d47a3a77e342eb8bead1ebf700e08df9ce5a0b5.
    expect(contentHash(estimate)).toBe('c966476bb78f814712212d1c4bc47dcbdb8b5b08b044288762b7f0fc11268626');
    expect(agreementScopes(estimate).materialHash).toBe('249359de4c7da6224d3ce4189650042d21e0089c2e60274b5c7da8897487a155');

    const projected = buildPublicEstimateData(estimate, null, estimate.pieces, 'detailed');
    expect(contentHash(projected)).toBe(contentHash(estimate));
    expect(agreementScopes(projected).materialHash).toBe(agreementScopes(estimate).materialHash);
  });

  it.each([
    ['uFactor', '1.062'],
    ['shgc', '0.278'],
    ['vlt', '0.501'],
  ])('changes the material and legacy content fingerprints when %s changes', (field, value) => {
    const before = legacyFixture();
    before.pieces[0].energySnapshot = energySnapshot();
    const after = JSON.parse(JSON.stringify(before));
    after.pieces[0].energySnapshot[field] = value;

    expect(contentHash(after)).not.toBe(contentHash(before));
    expect(agreementScopes(after).materialHash).not.toBe(agreementScopes(before).materialHash);
    expect(agreementScopes(after).charges).toEqual(agreementScopes(before).charges);
  });

  it('ignores capture time, source, notes, diagnostic reason and catalog record identity', () => {
    const before = legacyFixture();
    before.pieces[0].energySnapshot = energySnapshot();
    const after = JSON.parse(JSON.stringify(before));
    Object.assign(after.pieces[0].energySnapshot, {
      capturedAt: '2027-01-01T00:00:00.000Z',
      ratingId: 999,
      source: { file: 'another-private-source.xlsx', sheet: 'Updated', row: 800, version: '1.0', glassId: 'NEW', composition: 'different-private-reference' },
      notes: 'changed-private-note',
      reason: 'changed-private-diagnostic',
      selection: { idBrand: 123, idSyst: 456 },
    });

    expect(contentHash(after)).toBe(contentHash(before));
    expect(agreementScopes(after)).toEqual(agreementScopes(before));
    expect(agreementContent(before).pieces[0].energy).toEqual({
      schemaVersion: 1, status: 'AVAILABLE', uFactor: '1.075', shgc: '0.586', vlt: '0.674',
    });
    expect(JSON.stringify(agreementContent(before))).not.toContain('private-');

    const beforePublic = buildPublicEstimateData(before, null, before.pieces, 'detailed');
    const afterPublic = buildPublicEstimateData(after, null, after.pieces, 'detailed');
    expect(agreementScopes(afterPublic)).toEqual(agreementScopes(beforePublic));
  });

  it('ignores retired units while preserving the energy values in fingerprints', () => {
    const before = legacyFixture();
    before.pieces[0].energySnapshot = energySnapshot();
    const after = JSON.parse(JSON.stringify(before));
    delete after.pieces[0].energySnapshot.units;
    expect(contentHash(after)).toBe(contentHash(before));
    expect(agreementScopes(after)).toEqual(agreementScopes(before));
    expect(agreementContent(after).pieces[0].energy).not.toHaveProperty('units');
  });

  it('captures an explicit availability change without converting missing metrics to zero', () => {
    const before = legacyFixture();
    before.pieces[0].energySnapshot = {
      ...energySnapshot(), status: 'UNAVAILABLE', uFactor: null, shgc: null, vlt: null,
    };
    const after = legacyFixture();
    after.pieces[0].energySnapshot = energySnapshot();
    expect(agreementContent(before).pieces[0].energy).toMatchObject({
      status: 'UNAVAILABLE', uFactor: null, shgc: null, vlt: null,
    });
    expect(contentHash(after)).not.toBe(contentHash(before));
    expect(agreementScopes(after).materialHash).not.toBe(agreementScopes(before).materialHash);
  });
});

import { buildPublicEstimateData } from './public-estimate-data';

function estimateFixture() {
  return {
    id: 41,
    idUser: 7,
    dealerModeSnapshot: 'INTERNAL',
    user: { role: { name: 'dealer' }, dealerMode: 'INTERNAL' },
    customerPriceT: '1000.00',
    customerTaxRate: '0.07',
    customerTaxAmount: '70.00',
    customerTotalPayable: '1070.00',
    customerCharges: [],
    pieces: [],
  };
}

function privateSnapshot() {
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
    source: {
      file: 'private-source-workbook.xlsx',
      sheet: 'private-source-sheet',
      row: 92,
      version: 'private-version',
      glassId: 'private-glass-id',
      composition: 'private-composition',
    },
    reason: 'private-diagnostic-reason',
    notes: 'private-catalog-notes',
    unexpectedFutureMetadata: { secret: 'private-future-metadata' },
  };
}

describe('Public estimate energy projection', () => {
  it.each(['detailed', 'total'] as const)(
    'publishes values but no source or diagnostic metadata in %s pricing mode',
    (mode) => {
      const snapshot = privateSnapshot();
      const original = JSON.parse(JSON.stringify(snapshot));
      const projected = buildPublicEstimateData(
        estimateFixture(),
        null,
        [{
          id: 1,
          qty: 2,
          customerPrice: '500.00',
          customerSubtotal: '1000.00',
          energySnapshot: snapshot,
          energyRating: { sourceFile: 'private-related-source', notes: 'private-related-notes' },
        }],
        mode,
      );

      expect(projected.pieces[0].energySnapshot).toEqual({
        schemaVersion: 1,
        status: 'AVAILABLE',
        uFactor: '1.075',
        shgc: '0.586',
        vlt: '0.674',
        ratingId: 71,
      });
      expect(projected.pieces[0]).not.toHaveProperty('energyRating');
      expect(JSON.stringify(projected)).not.toContain('private-');
      expect(projected.pieces[0].energySnapshot).not.toHaveProperty('source');
      expect(projected.pieces[0].energySnapshot).not.toHaveProperty('units');
      expect(projected.pieces[0].energySnapshot).not.toHaveProperty('selection');
      expect(projected.pieces[0].energySnapshot).not.toHaveProperty('capturedAt');
      expect(snapshot).toEqual(original);
    },
  );

  it.each([undefined, null, {}, { schemaVersion: 2, source: { file: 'private-source' } }])(
    'does not publish absent or unsupported snapshot %p',
    (energySnapshot) => {
      const projected = buildPublicEstimateData(
        estimateFixture(), null, [{ energySnapshot }], 'detailed',
      );
      expect(projected.pieces[0].energySnapshot).toBeNull();
      expect(JSON.stringify(projected)).not.toContain('private-source');
    },
  );

  it('keeps unavailable values null and retains valid zero coefficients', () => {
    const unavailable = { ...privateSnapshot(), status: 'UNAVAILABLE', uFactor: null, shgc: null, vlt: null };
    const zero = { ...privateSnapshot(), shgc: '0', vlt: '0' };
    const projected = buildPublicEstimateData(
      estimateFixture(), null, [{ energySnapshot: unavailable }, { energySnapshot: zero }], 'detailed',
    );
    expect(projected.pieces[0].energySnapshot).toMatchObject({
      status: 'UNAVAILABLE', uFactor: null, shgc: null, vlt: null,
    });
    expect(projected.pieces[1].energySnapshot).toMatchObject({ shgc: '0', vlt: '0' });
  });
});

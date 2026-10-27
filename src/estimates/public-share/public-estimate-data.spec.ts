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
  it.each(['detailed', 'total'] as const)('omits internal glass data from a solid garage design in %s mode without mutating stored selections', mode => {
    const piece = {
      idSyst: 33, idDesign: 7, idDesignColor: 8,
      idCryst: 1, idTint: 2, idCoat: 3, idPrivacy: 4,
      cryst: { glass: 'Internal base crystal' }, tin: { color: 'Internal tint' },
      coat: { name: 'Internal coating' }, privacyOption: { name: 'Internal privacy' },
      energySnapshot: privateSnapshot(), dpPosPsf: '45', dpNegPsf: '-55',
      diagramMetadata: { dimensionMode: 'STANDARD', hasCoating: true, hasPrivacy: true, garageMaxSectionHeightIn: 24 },
      designSnapshot: {
        version: 1, systemId: 33,
        design: { id: 7, name: 'Any name', imageUrl: null, template: { version: 1, columns: [1], rows: [1], cells: [['slat']] } },
        color: { id: 8, name: 'Finish', hexCode: '#885533' },
      },
    };
    const before = JSON.parse(JSON.stringify(piece));
    const projected = buildPublicEstimateData(estimateFixture(), null, [piece], mode).pieces[0];
    expect(projected).toMatchObject({
      idCryst: null, idTint: null, idCoat: null, idPrivacy: null,
      cryst: null, tin: null, coat: null, privacyOption: null, energySnapshot: null,
      idDesign: 7, idDesignColor: 8, dpPosPsf: '45', dpNegPsf: '-55',
      diagramMetadata: { hasCoating: false, hasPrivacy: false, garageMaxSectionHeightIn: 24 },
    });
    expect(projected.designSnapshot).toEqual(piece.designSnapshot);
    expect(piece).toEqual(before);

    piece.designSnapshot.design.template.cells = [['glass']];
    const withGlass = buildPublicEstimateData(estimateFixture(), null, [piece], mode).pieces[0];
    expect(withGlass.cryst).toEqual(piece.cryst);
    expect(withGlass.privacyOption).toEqual(piece.privacyOption);
    expect(withGlass.energySnapshot?.status).toBe('AVAILABLE');
  });

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

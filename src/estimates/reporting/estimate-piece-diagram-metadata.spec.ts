import { attachEstimatePieceDiagramMetadata } from './estimate-piece-diagram-metadata';

describe('garage section height in report diagram metadata', () => {
  it('does not query or present glass appearance flags for captured all-slat designs', async () => {
    const db = {
      sysConf: { findMany: jest.fn(async () => [{ idSystem: 3, idConfig: 1, dimensionMode: 'STANDARD', system: { garageMaxSectionHeightIn: 24 } }]) },
      brandCoating: { findMany: jest.fn() }, brandPrivacy: { findMany: jest.fn() },
    };
    const piece = {
      idSyst: 3, idConf: 1, idBrand: 2, idCoat: 5, idPrivacy: 6,
      idDesign: 7, idDesignColor: 8,
      designSnapshot: {
        version: 1, systemId: 3,
        design: { id: 7, name: 'Solid geometry', imageUrl: null, template: { version: 1, columns: [1], rows: [1], cells: [['slat']] } },
        color: { id: 8, name: 'Finish', hexCode: '#885533' },
      },
    };
    const result = await attachEstimatePieceDiagramMetadata(db as any, [piece]);
    expect(result[0].diagramMetadata).toEqual({ dimensionMode: 'STANDARD', garageMaxSectionHeightIn: 24, hasCoating: false, hasPrivacy: false });
    expect(db.brandCoating.findMany).not.toHaveBeenCalled();
    expect(db.brandPrivacy.findMany).not.toHaveBeenCalled();
    expect(result[0].idCoat).toBe(5);
    expect(result[0].idPrivacy).toBe(6);
  });

  it('uses each system configuration and keeps glass appearance flags', async () => {
    const db = {
      sysConf: { findMany: jest.fn(async () => [
        { idSystem: 3, idConfig: 1, dimensionMode: 'STANDARD', system: { garageMaxSectionHeightIn: '24.00' } },
        { idSystem: 4, idConfig: 1, dimensionMode: 'STANDARD', system: { garageMaxSectionHeightIn: '20.50' } },
      ]) },
      brandCoating: { findMany: jest.fn(async () => [{ idBrand: 2, idCoating: 5, surchargeEnabled: true }]) },
      brandPrivacy: { findMany: jest.fn(async () => [{ idBrand: 2, idPrivacy: 6, surchargeEnabled: true }]) },
    };
    const pieces = [3, 4].map(idSyst => ({ idSyst, idConf: 1, idBrand: 2, idCoat: 5, idPrivacy: 6 }));
    const result = await attachEstimatePieceDiagramMetadata(db as any, pieces);
    expect(result.map(piece => piece.diagramMetadata)).toEqual([
      { dimensionMode: 'STANDARD', garageMaxSectionHeightIn: 24, hasCoating: true, hasPrivacy: true },
      { dimensionMode: 'STANDARD', garageMaxSectionHeightIn: 20.5, hasCoating: true, hasPrivacy: true },
    ]);
    expect(db.sysConf.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ system: { select: { garageMaxSectionHeightIn: true } } }),
    }));
  });

  it('does not introduce invalid section limits or change metadata for a missing configuration', async () => {
    const db = {
      sysConf: { findMany: jest.fn(async () => [
        { idSystem: 3, idConfig: 1, dimensionMode: 'STANDARD', system: { garageMaxSectionHeightIn: 0 } },
      ]) },
    };
    const result = await attachEstimatePieceDiagramMetadata(db as any, [3, 4].map(idSyst => ({
      idSyst, idConf: 1, idBrand: 2, idCoat: null, idPrivacy: null,
    })));
    expect(result.map(piece => piece.diagramMetadata)).toEqual([
      { dimensionMode: 'STANDARD', hasCoating: false, hasPrivacy: false },
      { dimensionMode: 'STANDARD', hasCoating: false, hasPrivacy: false },
    ]);
  });
});

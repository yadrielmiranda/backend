import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { presentApiResponse } from '@/common/response-privacy.interceptor';
import { withStoredPieceDesign } from '@/pieces/piece-design';
import { frenchDoorKind, seriesDoorDesignKind } from './door-design-policy';
import { doorDesignContent, doorDesignPersistence, resolveDoorDesign } from './piece-door-design';

const input = { idProd: 5, idBrand: 2, idSyst: 10, idConf: 4, idFC: 7, idDoorDesign: 21 };
const frenchDoor = { id: 5, diagramFamily: 'FRENCH_DOOR', kind: 'GLAZED_UNIT' };
const catalog = { id: 21, code: 'MY-01', artworkKey: 'DD01', kind: 'DOUBLE' as const, unitPrice: new Prisma.Decimal('500.25') };
function fixture(config = 'OXXO') {
  const link = { design: { ...catalog }, sysConf: { dimensionMode: 'STANDARD', isSelectableInEstimate: true,
    system: { allowDesign: true, isActive: true, idBrand: 2, idProduct: 5, brandProduct: { product: { ...frenchDoor } } },
    config: { isActive: true, idProduct: 5, conf: config } } };
  const db: any = { sysConf: { findUnique: jest.fn().mockResolvedValue(link.sysConf) },
    frenchDoorDesign: { findUnique: jest.fn().mockResolvedValue(link.design) },
    muntinPattern: { findUnique: jest.fn() } };
  return { link, db };
}

describe('French Door pilot designs', () => {
  it.each([['X','SINGLE'],['OOX','SINGLE'],['xo','SINGLE'],['O-XX-O','DOUBLE'],['O',''],['OXOX',''],['XOXX','']])(
    'classifies %s without charging a sidelite', (config, kind) => {
      for (const mode of ['STANDARD', 'ECO_WINDOWS_DOOR', 'ECO_NOVO_DOOR']) {
        expect(frenchDoorKind(frenchDoor, config, mode)).toBe(kind || null);
        expect(frenchDoorKind({ ...frenchDoor, kind: 'LINEAR_MATERIAL' }, config, mode)).toBeNull();
        expect(frenchDoorKind({ ...frenchDoor, diagramFamily: 'GARAGE_DOOR' }, config, mode)).toBeNull();
      }
      expect(frenchDoorKind(frenchDoor, config, 'WINDOW_WALL')).toBeNull();
    },
  );
  it('quotes the catalog row and keeps the saved price if a series is disabled or the catalog changes', async () => {
    const { db } = fixture();
    const result = await resolveDoorDesign(db, { ...input, doorDesignSnapshot: { ...catalog, unitPrice: '0' } });
    expect(result.doorDesignSnapshot).toEqual({
      version: 1, id: 21, code: 'MY-01', artworkKey: 'DD01', kind: 'DOUBLE', unitPrice: '500.25', systemId: 10, configId: 4,
    });
    const stored = { ...input, ...result };
    db.sysConf.findUnique.mockResolvedValue(null);
    for (const idDoorDesign of [21, undefined]) {
      const reread = await resolveDoorDesign(db, withStoredPieceDesign({ ...input, idDoorDesign }, stored));
      expect(reread).toEqual(result);
      expect(doorDesignPersistence(reread).doorDesignSnapshot).toEqual(result.doorDesignSnapshot);
    }
    expect(db.sysConf.findUnique).toHaveBeenCalledTimes(1);
    await expect(resolveDoorDesign(db, withStoredPieceDesign({ ...input, idConf: 8 }, stored))).rejects.toThrow('unavailable');
    expect(await resolveDoorDesign(db, withStoredPieceDesign({ ...input, idDoorDesign: null }, stored))).toEqual({
      idDoorDesign: null, doorDesignSnapshot: null,
    });
    expect(doorDesignContent({})).toEqual({});
  });
  it('requires the right shape, an actual price (including explicit zero), and the same system/product/brand', async () => {
    for (const config of ['O','X']) await expect(resolveDoorDesign(fixture(config).db, input)).rejects.toBeInstanceOf(BadRequestException);
    const { db, link } = fixture();
    await expect(resolveDoorDesign(db, { ...input, idProd: 8 })).rejects.toThrow('match');
    await expect(resolveDoorDesign(db, { ...input, idBrand: 8 })).rejects.toThrow('match');
    db.frenchDoorDesign.findUnique.mockResolvedValueOnce({ ...catalog, unitPrice: null });
    await expect(resolveDoorDesign(db, input)).rejects.toThrow('unavailable');
    link.design.unitPrice = new Prisma.Decimal(0);
    expect((await resolveDoorDesign(db, input)).doorDesignSnapshot.unitPrice).toBe('0.00');
    link.sysConf.system.allowDesign = false;
    await expect(resolveDoorDesign(db, input)).rejects.toThrow('unavailable');
    link.sysConf.system.allowDesign = true;
    link.sysConf.system.brandProduct.product.kind = 'LINEAR_MATERIAL';
    await expect(resolveDoorDesign(db, input)).rejects.toThrow('match');
  });
  it('rejects GRID and PRESET even without a type and accepts Full View', async () => {
    const { db } = fixture();
    const selection = { ...input, muntin: { idPattern: 2 } };
    for (const inputMode of ['GRID','PRESET']) {
      db.muntinPattern.findUnique.mockResolvedValueOnce({ inputMode });
      await expect(resolveDoorDesign(db, selection)).rejects.toThrow('muntin');
    }
    db.muntinPattern.findUnique.mockResolvedValueOnce({ inputMode: 'NONE' });
    await expect(resolveDoorDesign(db, selection)).resolves.toHaveProperty('idDoorDesign',21);
  });
  it('hides unit costs in historical nested piece snapshots while preserving the artwork for the dealer', async () => {
    const priced = await resolveDoorDesign(fixture().db, input);
    const asDealer = presentApiResponse({ pieces: [priced] }, { id: 5, role: { name: 'dealer' } });
    expect(asDealer.pieces[0].doorDesignSnapshot.artworkKey).toBe('DD01');
    expect(asDealer.pieces[0].doorDesignSnapshot.unitPrice).toBeUndefined();
    expect(presentApiResponse(priced, { id: 1, role: { name: 'admin' } }).doorDesignSnapshot.unitPrice).toBe('500.25');
  });
  it('omits mismatched options if a configuration was repurposed', () => {
    const options = { config: { idProduct: 5, conf: 'OXXO' }, dimensionMode: 'STANDARD' };
    const system = { allowDesign: true, brandProduct: { product: frenchDoor } };
    expect(seriesDoorDesignKind(system, options)).toBe('DOUBLE');
    expect(seriesDoorDesignKind(system, { ...options, config: { idProduct: 5, conf: 'O' } })).toBeNull();
    expect(seriesDoorDesignKind(system, { ...options, config: { idProduct: 8, conf: 'X' } })).toBeNull();
    expect(seriesDoorDesignKind({ ...system, allowDesign: false }, options)).toBeNull();
  });
});

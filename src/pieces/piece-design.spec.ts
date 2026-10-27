import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pieceDesignContent, pieceDesignPersistence, pieceHasSolidGarageDesign, resolvePieceDesign, withStoredPieceDesign } from './piece-design';

const input = { idProd: 1, idBrand: 2, idSyst: 3, idDesign: 4, idDesignColor: 5 };
const snapshot = {
  version: 1 as const, systemId: 3,
  design: { id: 4, name: 'Solid', imageUrl: '/solid.png', template: { version: 1, columns: [0.5, 0.5], rows: [1], cells: [['slat', 'glass']] } },
  color: { id: 5, name: 'Oak', hexCode: '#995522', idFrameColor: 8 },
};
function fixture() {
  const option = {
    design: { ...snapshot.design, isActive: true },
    color: { ...snapshot.color, isActive: true },
    system: { allowDesign: true, isActive: true, idBrand: 2, idProduct: 1,
      brandProduct: { product: { diagramFamily: 'GARAGE_DOOR' } } },
  };
  const findUnique = jest.fn().mockResolvedValue(option);
  const frame = jest.fn().mockResolvedValue({ frameColor: { isActive: true } });
  const color = jest.fn().mockResolvedValue({ idFrameColor: 8 });
  return { option, findUnique, frame, color, db: { systemDesignOption: { findUnique },
    systemFrameColor: { findUnique: frame }, designColor: { findUnique: color } } as unknown as Prisma.TransactionClient };
}

describe('Piece design selections', () => {
  it('detects all-slat geometry from the matching saved snapshot regardless of design name', () => {
    const saved = { ...snapshot, design: { ...snapshot.design, name: 'Custom solid', template: {
      version: 1, columns: [0.5, 0.5], rows: [1], cells: [['slat', 'slat']],
    } } };
    expect(pieceHasSolidGarageDesign({ ...input, designSnapshot: saved })).toBe(true);
    expect(pieceHasSolidGarageDesign({ ...input, designSnapshot: snapshot })).toBe(false);
    expect(pieceHasSolidGarageDesign({ ...input, idDesign: null, designSnapshot: saved })).toBe(false);
    expect(pieceHasSolidGarageDesign({ ...input, idSyst: 999, designSnapshot: saved })).toBe(false);
    expect(pieceHasSolidGarageDesign({ ...input, idDesignColor: 999, designSnapshot: saved })).toBe(false);
    expect(pieceHasSolidGarageDesign({ ...input, designSnapshot: {
      ...saved, design: { ...saved.design, template: undefined },
    } })).toBe(false);
    expect(pieceHasSolidGarageDesign({ ...input, designSnapshot: {
      ...saved, design: { ...saved.design, template: { ...saved.design.template, cells: [] } },
    } })).toBe(false);
  });

  it('does not add a design to an ordinary piece or apply series defaults automatically', async () => {
    const { db, findUnique } = fixture();
    expect(await resolvePieceDesign(db, { idProd: 1, idBrand: 2, idSyst: 3 })).toEqual({
      idDesign: null, idDesignColor: null, designSnapshot: null,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('captures authoritative catalog values and ignores a client supplied snapshot', async () => {
    const { db } = fixture();
    const result = await resolvePieceDesign(db, { ...input, designSnapshot: { ...snapshot, color: { name: 'Forged' } } } as any);
    expect(result.designSnapshot).toEqual(snapshot);
    expect(result.idFC).toBe(8);
  });

  it('rejects an unlinked design color instead of keeping an unrelated frame', async () => {
    const f = fixture(); f.option.color.idFrameColor = null as any;
    await expect(resolvePieceDesign(f.db, { ...input, idFC: 1 } as any)).rejects.toThrow('Link this design color');
    expect(f.frame).not.toHaveBeenCalled();
  });

  it.each([null, { frameColor: { isActive: false } }])('rejects unavailable/inactive mapped frames: %p', async association => {
    const f = fixture(); f.frame.mockResolvedValue(association);
    await expect(resolvePieceDesign(f.db, input)).rejects.toThrow('must be active and available');
    expect(f.frame).toHaveBeenCalledWith(expect.objectContaining({
      where: { idSystem_idFrameColor: { idSystem: 3, idFrameColor: 8 } },
    }));
  });

  it('resolves legacy saved designs to the current link without changing their captured geometry/name', async () => {
    const f = fixture(); f.color.mockResolvedValue({ idFrameColor: 19 });
    const { idFrameColor, ...oldColor } = snapshot.color;
    const legacySnapshot = { ...snapshot, color: oldColor };
    const stored = { ...input, designSnapshot: legacySnapshot };
    const result = await resolvePieceDesign(f.db, withStoredPieceDesign({ ...input }, stored));
    expect(result.idFC).toBe(19);
    expect(result.designSnapshot).toEqual({ ...legacySnapshot, color: { ...oldColor, idFrameColor: 19 } });
    expect(f.findUnique).not.toHaveBeenCalled();
    expect(legacySnapshot.color).not.toHaveProperty('idFrameColor');
  });

  it('keeps a captured frame mapping after the catalog link changes', async () => {
    const f = fixture(); f.color.mockResolvedValue({ idFrameColor: 19 });
    const result = await resolvePieceDesign(f.db, withStoredPieceDesign({ ...input, idFC: 99 }, { ...input, designSnapshot: snapshot }));
    expect(result.idFC).toBe(8);
    expect(f.color).not.toHaveBeenCalled();
  });

  it('freezes the geometry from the database independently of later template edits', async () => {
    const { db, option } = fixture();
    const result = await resolvePieceDesign(db, input);
    expect(result.designSnapshot?.design.template?.cells).toEqual([['slat', 'glass']]);
    option.design.template = { version: 1, columns: [1], rows: [1], cells: [['glass']] };
    const edit = withStoredPieceDesign({ ...input }, { ...input, designSnapshot: result.designSnapshot });
    expect((await resolvePieceDesign(db, edit)).designSnapshot?.design.template?.cells).toEqual([['slat', 'glass']]);
  });

  it.each([
    { idDesign: 4, idDesignColor: null }, { idDesign: null, idDesignColor: 5 },
    { idDesign: 0, idDesignColor: 5 }, { idDesign: 4.5, idDesignColor: 5 },
  ])('rejects incomplete or invalid pair %p', async pair => {
    const { db } = fixture();
    await expect(resolvePieceDesign(db, { ...input, ...pair })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['missing', 'disabled', 'systemInactive', 'designInactive', 'colorInactive', 'wrongProduct', 'wrongBrand', 'wrongFamily'])(
    'rejects a new unavailable selection: %s', async reason => {
      const { db, option, findUnique } = fixture();
      if (reason === 'missing') findUnique.mockResolvedValue(null);
      if (reason === 'disabled') option.system.allowDesign = false;
      if (reason === 'systemInactive') option.system.isActive = false;
      if (reason === 'designInactive') option.design.isActive = false;
      if (reason === 'colorInactive') option.color.isActive = false;
      if (reason === 'wrongProduct') option.system.idProduct = 99;
      if (reason === 'wrongBrand') option.system.idBrand = 99;
      if (reason === 'wrongFamily') option.system.brandProduct.product.diagramFamily = 'SINGLE_HUNG';
      await expect(resolvePieceDesign(db, input)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('preserves a saved pair and its names after deactivation, removal or default/catalog changes', async () => {
    const { db, findUnique } = fixture();
    findUnique.mockResolvedValue(null);
    const edit = withStoredPieceDesign({ ...input, width: '124' }, { ...input, designSnapshot: snapshot });
    expect((await resolvePieceDesign(db, edit)).designSnapshot).toEqual(snapshot);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('preserves omitted fields from legacy editors but clears an explicit null pair', async () => {
    const { db } = fixture();
    const stored = { ...input, designSnapshot: snapshot };
    const legacy = withStoredPieceDesign({ idProd: 1, idBrand: 2, idSyst: 3 }, stored);
    expect((await resolvePieceDesign(db, legacy)).designSnapshot).toEqual(snapshot);
    const removed = withStoredPieceDesign({ ...input, idDesign: null, idDesignColor: null }, stored);
    expect(await resolvePieceDesign(db, removed)).toEqual({ idDesign: null, idDesignColor: null, designSnapshot: null });
    expect(pieceDesignPersistence(await resolvePieceDesign(db, removed)).designSnapshot).toBe(Prisma.DbNull);
  });

  it('does not grant historical access to clones or a different system/pair', async () => {
    const { db, findUnique } = fixture();
    findUnique.mockResolvedValue(null);
    const stored = { ...input, designSnapshot: snapshot };
    const existing = withStoredPieceDesign({ ...input }, stored);
    for (const newInput of [{ ...existing }, withStoredPieceDesign({ ...input, idSyst: 99 }, stored), withStoredPieceDesign({ ...input, idDesignColor: 99 }, stored)]) {
      await expect(resolvePieceDesign(db, newInput)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('keeps legacy content empty and includes selected values in saved content', () => {
    expect(pieceDesignContent({})).toEqual({});
    expect(pieceDesignContent({ idDesign: null, idDesignColor: null })).toEqual({});
    expect(pieceDesignContent({ ...input, designSnapshot: snapshot })).toEqual({ idDesign: 4, idDesignColor: 5, designSnapshot: snapshot });
  });
});

import { Prisma } from '@prisma/client';
import {
  buildEnergyPersistence,
  EnergyPieceSelection,
  EnergySnapshot,
  energyActiveKey,
  stripEnergySnapshotMetadata,
} from './energy-rating-lookup';

const selection: EnergyPieceSelection = {
  idBrand: 3,
  idProd: 2,
  idSyst: 10,
  idConf: 20,
  idCryst: 5,
  idTint: 1,
  idCoat: 2,
  idPrivacy: 1,
};
const rating = (overrides = {}) => ({
  id: 100,
  idSystem: 10,
  idCrystal: 5,
  idConfig: null,
  appliesToAllConfigs: true,
  uFactor: new Prisma.Decimal('1.062'),
  shgc: new Prisma.Decimal('0.278'),
  vlt: new Prisma.Decimal('0.501'),
  ...overrides,
});
const setup = (rows: any[] = []) => {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { findMany, db: { energyRating: { findMany } } as any };
};
const snapshotOf = (
  result: Awaited<ReturnType<typeof buildEnergyPersistence>>,
) => result.energySnapshot as unknown as EnergySnapshot;

describe('energy rating lookup', () => {
  it('strips only retired snapshot metadata and preserves null sentinels', () => {
    for (const value of [null, undefined, Prisma.DbNull, Prisma.JsonNull]) {
      expect(stripEnergySnapshotMetadata(value)).toBe(value);
    }
    const captured = {
      schemaVersion: 1,
      status: 'AVAILABLE',
      uFactor: '1.062314',
      shgc: '0.278000',
      vlt: '0.501000',
      capturedAt: '2026-10-18T12:00:00.000Z',
      ratingId: 100,
      selection,
    };
    const legacy = {
      ...captured,
      units: 'Btu/(h·ft²·°F)',
      source: { file: 'old.xlsx' },
    };
    expect(stripEnergySnapshotMetadata(legacy)).toEqual(captured);
    expect(legacy).toHaveProperty('units');
    expect(legacy).toHaveProperty('source');
    expect(stripEnergySnapshotMetadata(captured)).toBe(captured);
  });

  it('queries only the exact IDs and verifies brand/product scope', async () => {
    const { db, findMany } = setup([rating()]);
    const result = await buildEnergyPersistence(db, selection);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          idSystem: 10,
          idCrystal: 5,
          idTint: 1,
          idCoating: 2,
          idPrivacy: 1,
          systemCrystal: { system: { idBrand: 3, idProduct: 2 } },
          OR: [{ idConfig: 20 }, { idConfig: null, appliesToAllConfigs: true }],
        }),
      }),
    );
    expect(snapshotOf(result)).toMatchObject({
      status: 'AVAILABLE',
      uFactor: '1.062',
      shgc: '0.278',
      vlt: '0.501',
      ratingId: 100,
      selection,
    });
    expect(snapshotOf(result)).not.toHaveProperty('source');
    expect(snapshotOf(result)).not.toHaveProperty('units');
  });

  it('prefers the exact configuration over an explicitly general entry', async () => {
    const { db } = setup([
      rating(),
      rating({
        id: 101,
        idConfig: 20,
        appliesToAllConfigs: false,
        shgc: new Prisma.Decimal('0.3'),
      }),
    ]);
    const result = await buildEnergyPersistence(db, selection);
    expect(snapshotOf(result)).toMatchObject({ ratingId: 101, shgc: '0.3' });
  });

  it('does not use a general row that lacks explicit configuration scope', async () => {
    const { db } = setup([rating({ appliesToAllConfigs: false })]);
    expect(
      snapshotOf(await buildEnergyPersistence(db, selection)),
    ).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'NO_EXACT_MATCH',
      uFactor: null,
    });
  });

  it('does not guess among duplicate specific records', async () => {
    const { db } = setup([
      rating({ idConfig: 20 }),
      rating({ id: 101, idConfig: 20 }),
    ]);
    const result = await buildEnergyPersistence(db, selection);
    expect(snapshotOf(result)).toMatchObject({
      status: 'AMBIGUOUS',
      ratingId: null,
      uFactor: null,
    });
  });

  it('represents missing and incomplete values as unavailable, never fabricated zeros', async () => {
    const { db } = setup([rating({ vlt: null })]);
    expect(
      snapshotOf(await buildEnergyPersistence(db, selection)),
    ).toMatchObject({
      status: 'UNAVAILABLE',
      uFactor: null,
      shgc: null,
      vlt: null,
      ratingId: 100,
    });
    const empty = setup();
    expect(
      snapshotOf(await buildEnergyPersistence(empty.db, selection)),
    ).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'NO_EXACT_MATCH',
      ratingId: null,
    });
  });

  it('preserves valid zero SHGC/VLT values', async () => {
    const { db } = setup([
      rating({ shgc: new Prisma.Decimal(0), vlt: new Prisma.Decimal(0) }),
    ]);
    expect(
      snapshotOf(await buildEnergyPersistence(db, selection)),
    ).toMatchObject({
      status: 'AVAILABLE',
      shgc: '0',
      vlt: '0',
    });
  });

  it('does not query with incomplete selection or linear material', async () => {
    const { db, findMany } = setup();
    expect(
      snapshotOf(
        await buildEnergyPersistence(db, { ...selection, idPrivacy: null }),
      ),
    ).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'INCOMPLETE_SELECTION',
    });
    expect(
      snapshotOf(
        await buildEnergyPersistence(db, { ...selection, isLinear: true }),
      ),
    ).toMatchObject({
      status: 'NOT_APPLICABLE',
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('retains a snapshot through catalog revisions and ordinary piece edits', async () => {
    const first = setup([rating()]);
    const existing = await buildEnergyPersistence(first.db, selection);
    const revised = setup([
      rating({ id: 102, uFactor: new Prisma.Decimal('0.9') }),
    ]);
    const result = await buildEnergyPersistence(
      revised.db,
      selection,
      existing,
    );
    expect(result).toEqual(existing);
    expect(revised.findMany).not.toHaveBeenCalled();
    const changed = await buildEnergyPersistence(
      revised.db,
      { ...selection, idCoat: 3 },
      existing,
    );
    expect(snapshotOf(changed)).toMatchObject({
      ratingId: 102,
      uFactor: '0.9',
    });
    expect(revised.findMany).toHaveBeenCalledTimes(1);
  });

  it('retains unavailable snapshots until explicitly refreshed', async () => {
    const empty = setup();
    const existing = await buildEnergyPersistence(empty.db, selection);
    const revised = setup([rating()]);
    expect(
      await buildEnergyPersistence(revised.db, selection, existing),
    ).toEqual(existing);
    expect(revised.findMany).not.toHaveBeenCalled();
    expect(
      snapshotOf(await buildEnergyPersistence(revised.db, selection)).status,
    ).toBe('AVAILABLE');
  });

  it('removes legacy units and source metadata without recapturing published values', async () => {
    const first = setup([rating()]);
    const saved = await buildEnergyPersistence(first.db, selection);
    const previous = {
      ...saved,
      energySnapshot: {
        ...snapshotOf(saved),
        source: { file: 'old.xlsx', row: 93, composition: 'Old description' },
        units: 'Btu/(h·ft²·°F)',
      },
    };
    const current = setup([rating({ uFactor: new Prisma.Decimal('0.9') })]);
    const result = await buildEnergyPersistence(current.db, selection, previous);
    expect(result).toEqual(saved);
    expect(result.energySnapshot).not.toHaveProperty('source');
    expect(result.energySnapshot).not.toHaveProperty('units');
    expect(previous.energySnapshot).toHaveProperty('source');
    expect(previous.energySnapshot).toHaveProperty('units');
    expect(current.findMany).not.toHaveBeenCalled();
  });

  it('keeps uncaptured legacy pieces null through unrelated edits', async () => {
    const { db, findMany } = setup([rating()]);
    const legacy = { ...selection, energyRatingId: null, energySnapshot: null };
    const unchanged = await buildEnergyPersistence(db, selection, legacy);
    expect(unchanged).toEqual({
      energyRatingId: null,
      energySnapshot: Prisma.DbNull,
    });
    expect(findMany).not.toHaveBeenCalled();
    const changed = await buildEnergyPersistence(
      db,
      { ...selection, idCoat: 3 },
      legacy,
    );
    expect(snapshotOf(changed).status).toBe('AVAILABLE');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('distinguishes configuration scopes in the database uniqueness key', () => {
    const ids = {
      idSystem: 1,
      idCrystal: 2,
      idTint: 3,
      idCoating: 4,
      idPrivacy: 5,
    };
    expect(energyActiveKey(ids)).toBe('1:2:3:4:5:*');
    expect(energyActiveKey({ ...ids, idConfig: 6 })).toBe('1:2:3:4:5:6');
  });
});

import { Prisma } from '@prisma/client';
import { MaterialRevisionsService } from './material-revisions.service';
import * as snapshots from './material-revision-snapshot';
import { createEstimateRevisionPieceFingerprint } from '@/installation/installation-flow-policy';

jest.mock('@/payment-plans/payment-schedule', () => ({
  ...jest.requireActual('@/payment-plans/payment-schedule'),
  synchronizeScheduleChanges: jest.fn(async () => undefined),
  refreshScheduledInstallation: jest.fn(async () => undefined),
}));

const energy = (uFactor = '1.062') => ({
  energyRatingId: 100,
  energySnapshot: {
    schemaVersion: 1,
    status: 'AVAILABLE',
    uFactor,
    shgc: '0.278',
    vlt: '0.501',
    ratingId: 100,
    capturedAt: '2026-10-18T12:00:00.000Z',
  },
});

function fixture() {
  const estimate: any = {
    id: 1,
    number: '190001',
    idUser: 7,
    status: { name: 'Active' },
    taxRate: '0',
    customerTaxRate: '0',
    payments: [],
    pieces: [{ id: 8, idEst: 1, qty: 1, mark: 'W1', idCoat: 2 }],
    order: null,
    installationJob: null,
  };
  let nextId = 900;
  const db: any = {
    estimate: {
      findUnique: jest.fn(async () => estimate),
      findUniqueOrThrow: jest.fn(async () => ({ paymentPlanSnapshot: null })),
      update: jest.fn(async ({ data }) => Object.assign(estimate, data)),
    },
    materialRevision: { update: jest.fn(async () => ({})) },
    eventLog: { create: jest.fn(async () => ({})) },
    estimateAgreement: { findMany: jest.fn(async () => []) },
  };
  const installation: any = {
    persistMaterialRevisionPiece: jest.fn(
      async (_estimateId, input, _pricing, _db, original, frozen) => {
        const record = {
          ...original,
          ...input,
          id: original?.id ?? nextId++,
          ...(frozen ?? energy()),
        };
        estimate.pieces = original
          ? estimate.pieces.map((row) =>
              row.id === original.id ? record : row,
            )
          : [...estimate.pieces, record];
        return record;
      },
    ),
    stageMaterialRevisionInstallation: jest.fn(async () => null),
  };
  const calculator: any = {
    calculateEstimateTotalsFromPersistedPieces: jest.fn(() => ({})),
  };
  const notifications: any = {
    createAndSendToRoles: jest.fn(async () => undefined),
  };
  const service = new MaterialRevisionsService(
    db,
    calculator,
    installation,
    {} as any,
    notifications,
  );
  return { service, db, estimate, installation };
}

afterEach(() => jest.restoreAllMocks());

describe('frozen energy in material revisions', () => {
  it('captures each simulated piece on its server item, including additions with temporary IDs', async () => {
    const f = fixture();
    jest
      .spyOn(snapshots, 'revisionProjectSummary')
      .mockReturnValue({ projectTotal: '100' } as any);
    const items: any[] = [
      {
        key: 'new-window',
        action: 'ADD',
        originalPieceId: null,
        input: { qty: 1, mark: 'W2', idCoat: 3 },
        pricing: { price: '100' },
      },
    ];
    const result = await (f.service as any).buildProposal(
      f.db,
      f.estimate,
      items,
      7,
      1,
    );
    expect(
      f.installation.persistMaterialRevisionPiece.mock.calls[0],
    ).toHaveLength(5);
    expect(items[0].pricing.energy).toEqual(energy());
    expect(
      result.proposal.pieces.find((row) => row.id === 900).energySnapshot,
    ).toEqual(energy().energySnapshot);
  });

  it.each(['ADD', 'UPDATE'])(
    'applies stored energy for %s even if the catalog has since changed',
    async (action) => {
      const f = fixture();
      const frozen = energy('0.95');
      const item = {
        key: 'reviewed-item',
        action,
        originalPieceId: action === 'UPDATE' ? 8 : null,
        input: { qty: 1, mark: 'W2', idCoat: 3 },
        pricing: { price: '100', energy: {
          ...frozen, energySnapshot: { ...frozen.energySnapshot, units: 'Btu/(h·ft²·°F)' },
        } },
      };
      const revision = {
        id: 1,
        version: 1,
        estimateId: 1,
        approvedAt: new Date(),
        baseHash: snapshots.materialRevisionBaseHash(f.estimate),
        items: [item],
        proposal: {
          pieces: [{ id: 123, ...frozen }],
          totals: {},
          installation: null,
        },
      };
      await (f.service as any).apply(f.db, f.estimate, revision, 7);
      expect(
        f.installation.persistMaterialRevisionPiece.mock.calls[0][5],
      ).toEqual(frozen);
      const saved = f.estimate.pieces.find((row) => row.mark === 'W2');
      expect(saved.energySnapshot.uFactor).toBe('0.95');
      if (action === 'ADD') expect(saved.id).not.toBe(123);
    },
  );

  it('keeps a legacy approved proposal without inferred energy values', async () => {
    const f = fixture();
    const revision = {
      id: 1,
      version: 1,
      estimateId: 1,
      approvedAt: new Date(),
      baseHash: snapshots.materialRevisionBaseHash(f.estimate),
      items: [
        {
          key: 'old',
          action: 'ADD',
          originalPieceId: null,
          input: { qty: 1, mark: 'W2' },
          pricing: { price: '100' },
        },
      ],
      proposal: { totals: {}, installation: null },
    };
    await (f.service as any).apply(f.db, f.estimate, revision, 7);
    expect(
      f.installation.persistMaterialRevisionPiece.mock.calls[0][5],
    ).toEqual({
      energyRatingId: null,
      energySnapshot: Prisma.DbNull,
    });
  });
});

describe('energy revision fingerprints', () => {
  it('preserves pre-migration base hashes when nullable energy columns are added', () => {
    const f = fixture();
    const legacy = snapshots.materialRevisionBaseHash(f.estimate);
    f.estimate.pieces[0].energyRatingId = null;
    f.estimate.pieces[0].energySnapshot = null;
    expect(snapshots.materialRevisionBaseHash(f.estimate)).toBe(legacy);
    Object.assign(f.estimate.pieces[0], energy());
    const captured = snapshots.materialRevisionBaseHash(f.estimate);
    expect(captured).not.toBe(legacy);
    f.estimate.pieces[0].energySnapshot.units = 'Btu/(h·ft²·°F)';
    expect(snapshots.materialRevisionBaseHash(f.estimate)).toBe(captured);
    delete f.estimate.pieces[0].energySnapshot.units;
    f.estimate.pieces[0].energySnapshot.uFactor = '0.95';
    expect(snapshots.materialRevisionBaseHash(f.estimate)).not.toBe(captured);
  });

  it('keeps groups separate when the frozen energy values differ but ignores provenance-only differences', () => {
    const input = { idProd: 1, idSyst: 2, idCoat: 3 };
    const pricing = {
      rate: '80',
      price: '100',
      customerPrice: '120',
      dealerMarkupDecimal: '.2',
    };
    const a = createEstimateRevisionPieceFingerprint(input, {
      ...pricing,
      energy: energy(),
    });
    const b = createEstimateRevisionPieceFingerprint(input, {
      ...pricing,
      energy: energy('0.95'),
    });
    expect(a).not.toBe(b);
    const renamed = energy();
    renamed.energyRatingId = 999;
    renamed.energySnapshot.ratingId = 999;
    renamed.energySnapshot.capturedAt = '2026-10-20T12:00:00.000Z';
    expect(
      createEstimateRevisionPieceFingerprint(input, {
        ...pricing,
        energy: renamed,
      }),
    ).toBe(a);
    expect(
      createEstimateRevisionPieceFingerprint(input, {
        ...pricing,
        energy: { energyRatingId: null, energySnapshot: null },
      }),
    ).toBe(createEstimateRevisionPieceFingerprint(input, pricing));
  });
});

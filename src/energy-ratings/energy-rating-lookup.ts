import { Prisma } from '@prisma/client';

export interface EnergyPieceSelection {
  idBrand?: number | null;
  idProd?: number | null;
  idSyst?: number | null;
  idConf?: number | null;
  idCryst?: number | null;
  idTint?: number | null;
  idCoat?: number | null;
  idPrivacy?: number | null;
  isLinear?: boolean;
}

const selectionKeys = [
  'idBrand',
  'idProd',
  'idSyst',
  'idConf',
  'idCryst',
  'idTint',
  'idCoat',
  'idPrivacy',
] as const;

export type EnergySnapshot = {
  schemaVersion: 1;
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'AMBIGUOUS' | 'NOT_APPLICABLE';
  uFactor: string | null;
  shgc: string | null;
  vlt: string | null;
  ratingId: number | null;
  selection: Record<(typeof selectionKeys)[number], number | null>;
  capturedAt: string;
  reason?: string;
};

/** Retains captured values while removing metadata retired from energy snapshots. */
export function stripEnergySnapshotMetadata<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (
    !Object.prototype.hasOwnProperty.call(value, 'units') &&
    !Object.prototype.hasOwnProperty.call(value, 'source')
  ) {
    return value;
  }
  const snapshot = { ...value } as T & { units?: unknown; source?: unknown };
  delete snapshot.units;
  delete snapshot.source;
  return snapshot;
}

export function energyActiveKey(selection: {
  idSystem: number;
  idCrystal: number;
  idTint: number;
  idCoating: number;
  idPrivacy: number;
  idConfig?: number | null;
}): string {
  return [
    selection.idSystem,
    selection.idCrystal,
    selection.idTint,
    selection.idCoating,
    selection.idPrivacy,
    selection.idConfig ?? '*',
  ].join(':');
}

function normalizedSelection(
  input: EnergyPieceSelection,
): EnergySnapshot['selection'] {
  return Object.fromEntries(
    selectionKeys.map((key) => [
      key,
      Number.isInteger(input[key]) && input[key] > 0 ? input[key] : null,
    ]),
  ) as EnergySnapshot['selection'];
}

function isSnapshot(value: unknown): value is EnergySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as EnergySnapshot;
  return (
    snapshot.schemaVersion === 1 &&
    !!snapshot.selection &&
    ['AVAILABLE', 'UNAVAILABLE', 'AMBIGUOUS', 'NOT_APPLICABLE'].includes(
      snapshot.status,
    ) &&
    typeof snapshot.capturedAt === 'string'
  );
}

/** Exact IDs only. An unchanged selection retains its original published values. */
export async function buildEnergyPersistence(
  db: Pick<Prisma.TransactionClient, 'energyRating'>,
  input: EnergyPieceSelection,
  existingPiece?: EnergyPieceSelection & {
    energyRatingId?: number | null;
    energySnapshot?: unknown;
  },
): Promise<{
  energyRatingId: number | null;
  energySnapshot: Prisma.InputJsonValue | typeof Prisma.DbNull;
}> {
  const selection = normalizedSelection(input);
  const previous = existingPiece?.energySnapshot;
  const complete = selectionKeys.every((key) => selection[key] !== null);
  const existingSelection = existingPiece
    ? normalizedSelection(existingPiece)
    : null;
  // Old estimates stay uncaptured until an explicit refresh or glass selection change.
  // Presence of the original IDs distinguishes a persisted piece from a snapshot-only caller.
  if (
    existingPiece &&
    (previous == null ||
      previous === Prisma.DbNull ||
      previous === Prisma.JsonNull) &&
    selectionKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(existingPiece, key),
    ) &&
    selectionKeys.every((key) => existingSelection[key] === selection[key])
  ) {
    return {
      energyRatingId: existingPiece.energyRatingId ?? null,
      energySnapshot: Prisma.DbNull,
    };
  }
  if (
    isSnapshot(previous) &&
    (complete || (input.isLinear && previous.status === 'NOT_APPLICABLE')) &&
    selectionKeys.every((key) => previous.selection[key] === selection[key]) &&
    (input.isLinear
      ? previous.status === 'NOT_APPLICABLE'
      : previous.status !== 'NOT_APPLICABLE')
  ) {
    return {
      energyRatingId: existingPiece.energyRatingId ?? null,
      energySnapshot: stripEnergySnapshotMetadata(
        previous,
      ) as unknown as Prisma.InputJsonValue,
    };
  }

  const snapshot: EnergySnapshot = {
    schemaVersion: 1,
    status: 'UNAVAILABLE',
    uFactor: null,
    shgc: null,
    vlt: null,
    ratingId: null,
    selection,
    capturedAt: new Date().toISOString(),
  };
  const result = () => ({
    energyRatingId: snapshot.ratingId,
    energySnapshot: snapshot as unknown as Prisma.InputJsonValue,
  });
  if (input.isLinear) {
    snapshot.status = 'NOT_APPLICABLE';
    snapshot.reason = 'LINEAR_MATERIAL';
    return result();
  }
  if (!complete) {
    snapshot.reason = 'INCOMPLETE_SELECTION';
    return result();
  }
  const matches = await db.energyRating.findMany({
    where: {
      idSystem: selection.idSyst,
      idCrystal: selection.idCryst,
      idTint: selection.idTint,
      idCoating: selection.idCoat,
      idPrivacy: selection.idPrivacy,
      isActive: true,
      systemCrystal: {
        system: { idBrand: selection.idBrand, idProduct: selection.idProd },
      },
      OR: [
        { idConfig: selection.idConf },
        { idConfig: null, appliesToAllConfigs: true },
      ],
    },
    orderBy: { id: 'asc' },
  });
  const specific = matches.filter((row) => row.idConfig === selection.idConf);
  const candidates = specific.length
    ? specific
    : matches.filter((row) => row.idConfig === null && row.appliesToAllConfigs);
  if (!candidates.length) {
    snapshot.reason = 'NO_EXACT_MATCH';
    return result();
  }
  if (candidates.length !== 1) {
    snapshot.status = 'AMBIGUOUS';
    snapshot.reason = 'MULTIPLE_EXACT_MATCHES';
    return result();
  }
  const rating = candidates[0];
  snapshot.ratingId = rating.id;
  if (
    rating.uFactor === null ||
    rating.shgc === null ||
    rating.vlt === null
  ) {
    snapshot.reason = 'SOURCE_VALUES_UNAVAILABLE';
    return result();
  }
  const uFactor = Number(rating.uFactor);
  const shgc = Number(rating.shgc);
  const vlt = Number(rating.vlt);
  if (
    !Number.isFinite(uFactor) ||
    uFactor <= 0 ||
    !Number.isFinite(shgc) ||
    shgc < 0 ||
    shgc > 1 ||
    !Number.isFinite(vlt) ||
    vlt < 0 ||
    vlt > 1
  ) {
    snapshot.reason = 'SOURCE_VALUES_INVALID';
    return result();
  }
  snapshot.status = 'AVAILABLE';
  snapshot.uFactor = rating.uFactor.toString();
  snapshot.shgc = rating.shgc.toString();
  snapshot.vlt = rating.vlt.toString();
  return result();
}

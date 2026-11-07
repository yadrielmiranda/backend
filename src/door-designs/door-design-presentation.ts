type PieceSelection = {
  idDoorDesign?: number | null;
  idSyst?: number | null;
  idConf?: number | null;
  doorDesignSnapshot?: unknown;
};

// Signed documents may receive an already-redacted public estimate.
export function publicDoorDesignContent(piece: PieceSelection) {
  const value = piece.doorDesignSnapshot;
  if (!piece.idDoorDesign || !piece.idSyst || !piece.idConf || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1 || snapshot.id !== piece.idDoorDesign ||
    snapshot.systemId !== piece.idSyst || snapshot.configId !== piece.idConf ||
    typeof snapshot.code !== 'string' || typeof snapshot.artworkKey !== 'string' ||
    (snapshot.kind !== 'SINGLE' && snapshot.kind !== 'DOUBLE')
  ) return {};

  return {
    idDoorDesign: piece.idDoorDesign,
    doorDesignSnapshot: {
      version: 1,
      id: piece.idDoorDesign,
      code: snapshot.code,
      kind: snapshot.kind,
      artworkKey: snapshot.artworkKey,
      systemId: piece.idSyst,
      configId: piece.idConf,
    },
  };
}

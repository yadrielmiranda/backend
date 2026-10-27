import { readPieceDesignSnapshot } from './piece-design';

type PieceFrameSource = {
  idSyst?: number | null;
  idDesign?: number | null;
  idDesignColor?: number | null;
  designSnapshot?: unknown;
  fColor?: { color?: string | null } | null;
};

/** A saved design supplies the finished frame label, including older snapshots without a frame link. */
export function matchingPieceDesignSnapshot(piece: PieceFrameSource) {
  const snapshot = readPieceDesignSnapshot(piece.designSnapshot);
  if (!snapshot || snapshot.systemId <= 0 || snapshot.design.id <= 0 || snapshot.color.id <= 0 ||
      !snapshot.design.name.trim() || !snapshot.color.name.trim() ||
      !/^#[0-9a-f]{6}$/i.test(snapshot.color.hexCode)) return null;
  if ((piece.idSyst !== undefined && piece.idSyst !== snapshot.systemId) ||
      (piece.idDesign !== undefined && piece.idDesign !== snapshot.design.id) ||
      (piece.idDesignColor !== undefined && piece.idDesignColor !== snapshot.color.id)) return null;
  return snapshot;
}

export function pieceFrameColorName(piece: PieceFrameSource): string | null {
  const design = matchingPieceDesignSnapshot(piece);
  return design?.color.name.trim() || piece.fColor?.color?.trim() || null;
}

export const PIECE_MARK_MAX_LENGTH = 20;

export function normalizePieceMark(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function pieceMarkWithSuffix(mark: string, suffix: string): string {
  const safeSuffix = suffix.slice(-PIECE_MARK_MAX_LENGTH);
  const availableMarkLength = Math.max(
    0,
    PIECE_MARK_MAX_LENGTH - safeSuffix.length,
  );

  return `${mark.trim().slice(0, availableMarkLength)}${safeSuffix}`;
}

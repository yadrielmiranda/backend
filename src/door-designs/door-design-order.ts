// Keep administrator-defined codes in the order and positions returned by the query.
// Reorder only the standard catalog slots, separately for each door kind.
export function sortStandardDoorDesigns<T extends { code: string }>(designs: readonly T[]): T[] {
  const result = [...designs];
  for (const prefix of ['AE-SD-', 'AE-DD-']) {
    const entries: { index: number; design: T; sequence: bigint }[] = [];
    designs.forEach((design, index) => {
      if (design.code.startsWith(prefix) && /^\d+$/.test(design.code.slice(prefix.length))) {
        entries.push({ index, design, sequence: BigInt(design.code.slice(prefix.length)) });
      }
    });
    const ordered = [...entries].sort((left, right) =>
      left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0);
    entries.forEach(({ index }, offset) => { result[index] = ordered[offset].design; });
  }
  return result;
}

export const INCHES_PER_FOOT = 12;

export function inToFt(n: unknown): number {
  const v = Number(n ?? 0);
  return v / INCHES_PER_FOOT;
}

export function dimsInchesToFeet<T extends Record<string, unknown>>(dims: T): Record<keyof T, number> {
  const out: any = {};
  for (const k of Object.keys(dims)) out[k] = inToFt(dims[k]);
  return out;
}


export class DimensionParseError extends Error {}

export function normalizeInchesToEighthStep(
  raw: string | number | null | undefined,
  fieldLabel: string = "dimension",
  minInches: number = 1 // 👈 puedes pasar 1 para forzar mínimo 1"
): number {
  if (raw === null || raw === undefined || raw === "") {
    return 0; // o lanza error si quieres forzar siempre valor
  }

  if (typeof raw === "number") {
    return enforceEighthStep(raw, fieldLabel, minInches);
  }

  const s = String(raw).trim().replace(",", ".");
  if (!s) return 0;

  let value: number;

  // Caso 1: "36 3/8"
  let match = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (match) {
    const whole = parseInt(match[1], 10);
    const num = parseInt(match[2], 10);
    const den = parseInt(match[3], 10);

    if (![2, 4, 8].includes(den)) {
      throw new DimensionParseError(
        `${fieldLabel}: solo se permiten fracciones con denominador 2, 4 u 8 (1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8).`
      );
    }

    const frac = num / den;
    value = whole + frac;
    return enforceEighthStep(value, fieldLabel, minInches);
  }

  // Caso 2: "3/8"
  match = s.match(/^(\d+)\/(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const den = parseInt(match[2], 10);

    if (![2, 4, 8].includes(den)) {
      throw new DimensionParseError(
        `${fieldLabel}: solo se permiten fracciones con denominador 2, 4 u 8 (1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8).`
      );
    }

    value = num / den;
    return enforceEighthStep(value, fieldLabel, minInches);
  }

  // Caso 3: decimal o entero "36.375", "36"
  const numVal = Number(s);
  if (!isFinite(numVal)) {
    throw new DimensionParseError(`${fieldLabel}: valor inválido (${s}).`);
  }
  value = numVal;
  return enforceEighthStep(value, fieldLabel, minInches);
}

function enforceEighthStep(
  val: number,
  fieldLabel: string,
  minInches: number
): number {
  if (val < 0) {
    throw new DimensionParseError(`${fieldLabel}: no puede ser negativo.`);
  }

  if (val < minInches) {
    throw new DimensionParseError(
      `${fieldLabel}: debe ser al menos ${minInches}" de altura/ancho.`
    );
  }

  const whole = Math.floor(val);
  const frac = val - whole;

  const eighthsFloat = Math.round(frac * 8);
  const diff = Math.abs(frac * 8 - eighthsFloat);

  // si no cae justo en múltiplos de 1/8, rechazamos
  if (diff > 1e-6) {
    throw new DimensionParseError(
      `${fieldLabel}: solo se permiten fracciones en incrementos de 1/8" (1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8).`
    );
  }

  if (eighthsFloat < 0 || eighthsFloat > 7) {
    throw new DimensionParseError(
      `${fieldLabel}: fracción fuera de rango permitido (0" a 7/8").`
    );
  }

  const normalized = whole + eighthsFloat / 8;
  return Number(normalized.toFixed(3)); // 36.375, 47.125, etc.
}

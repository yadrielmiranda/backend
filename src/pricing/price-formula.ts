// src/pricing/price-formula.ts
import Decimal from 'decimal.js';

export function computeBasePrice(
  areaFt2: Decimal,
  perimeterFt: Decimal,
  A_glass_psf: Decimal,
  B_frame_plf: Decimal,
  C_fixed: Decimal
): Decimal {
  const mat = areaFt2.mul(A_glass_psf);
  const frm = perimeterFt.mul(B_frame_plf);
  return mat.add(frm).add(C_fixed);
}

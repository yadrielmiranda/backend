// @/pricing/price-formula.ts
import Decimal from 'decimal.js';

// precisión interna superior a la precisión
// almacenada en PricingRule para evitar redondeos intermedios.
Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
});

export function computeBasePrice(
  areaFt2: Decimal,
  perimeterFt: Decimal,
  A_glass_psf: Decimal,
  B_frame_plf: Decimal,
  C_fixed: Decimal,
): Decimal {
  const materialCost = areaFt2.mul(A_glass_psf);
  const frameCost = perimeterFt.mul(B_frame_plf);

  return materialCost
    .add(frameCost)
    .add(C_fixed);
}
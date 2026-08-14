import Decimal from "decimal.js";

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Applies area, perimeter and fixed surcharge costs to one physical glazed
 * component. Dimensions are geometric inches; SysConf billable dimensions
 * never enter this formula.
 */
export function computeGlassOptionSurcharge(
  widthIn: Decimal,
  heightIn: Decimal,
  areaCost: Decimal,
  perimeterCost: Decimal,
  fixedCost: Decimal,
): Decimal {
  if (
    !widthIn.isFinite() ||
    !heightIn.isFinite() ||
    widthIn.lte(0) ||
    heightIn.lte(0)
  ) {
    throw new Error("Surcharge dimensions must be greater than zero.");
  }

  if (
    !areaCost.isFinite() ||
    !perimeterCost.isFinite() ||
    !fixedCost.isFinite() ||
    areaCost.lt(0) ||
    perimeterCost.lt(0) ||
    fixedCost.lt(0)
  ) {
    throw new Error(
      "Surcharge Area Cost, Perimeter Cost and Fixed Cost must be zero or greater.",
    );
  }

  const widthFt = widthIn.div(12);
  const heightFt = heightIn.div(12);
  const areaFt2 = widthFt.mul(heightFt);
  const perimeterFt = widthFt.add(heightFt).mul(2);

  return areaFt2
    .mul(areaCost)
    .add(perimeterFt.mul(perimeterCost))
    .add(fixedCost);
}

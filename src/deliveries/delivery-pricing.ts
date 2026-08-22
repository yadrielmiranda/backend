import Decimal from 'decimal.js';

export const METERS_PER_MILE = new Decimal('1609.344');

export type DeliveryPricingInput = {
  distanceMeters: number;
  basePrice: Decimal.Value;
  includedMiles: Decimal.Value;
  additionalMilePrice: Decimal.Value;
  tollAmount?: Decimal.Value;
  taxRate?: Decimal.Value;
};

export function calculateDeliveryPricing(input: DeliveryPricingInput) {
  if (!Number.isInteger(input.distanceMeters) || input.distanceMeters < 0) {
    throw new Error('Route distance must be a non-negative integer.');
  }

  const basePrice = new Decimal(input.basePrice);
  const includedMiles = new Decimal(input.includedMiles);
  const additionalMilePrice = new Decimal(input.additionalMilePrice);
  const tollAmount = new Decimal(input.tollAmount ?? 0);
  const taxRate = new Decimal(input.taxRate ?? 0);

  if (basePrice.lte(0))
    throw new Error('Delivery base price must be positive.');
  if (includedMiles.lt(0)) {
    throw new Error('Included delivery miles cannot be negative.');
  }
  if (additionalMilePrice.lt(0)) {
    throw new Error('Additional-mile price cannot be negative.');
  }
  if (tollAmount.lt(0)) throw new Error('Toll amount cannot be negative.');
  if (taxRate.lt(0) || taxRate.gt(1)) {
    throw new Error('Tax rate must be a decimal fraction between 0 and 1.');
  }

  const roadMiles = new Decimal(input.distanceMeters).div(METERS_PER_MILE);
  const additionalMiles = Decimal.max(0, roadMiles.minus(includedMiles))
    .ceil()
    .toNumber();
  const subtotal = basePrice
    .add(additionalMilePrice.mul(additionalMiles))
    .add(tollAmount)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taxAmount = subtotal
    .mul(taxRate)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    roadMiles,
    basePrice,
    includedMiles,
    additionalMilePrice,
    additionalMiles,
    tollAmount,
    taxRate,
    subtotal,
    taxAmount,
    total: subtotal.add(taxAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  };
}

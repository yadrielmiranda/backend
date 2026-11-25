import Decimal from 'decimal.js';

export const METERS_PER_MILE = new Decimal('1609.344');

export function isWithinDeliveryCoverage(
  distanceMeters: number,
  maxDeliveryMiles: Decimal.Value,
) {
  return new Decimal(distanceMeters).lte(
    new Decimal(maxDeliveryMiles).mul(METERS_PER_MILE),
  );
}

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

  const roadMiles = new Decimal(input.distanceMeters)
    .div(METERS_PER_MILE)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const additionalMiles = Decimal.max(
    0,
    roadMiles.minus(includedMiles),
  ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
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

export function estimateStandardDeliveryPrice(distanceMeters: number, rates: {
  basePrice: string | null; includedMiles: string | null; additionalMilePrice: string | null;
}) {
  const { basePrice, includedMiles, additionalMilePrice } = rates;
  if (basePrice === null || includedMiles === null || additionalMilePrice === null) return null;
  try {
    const price = calculateDeliveryPricing({ distanceMeters, basePrice, includedMiles, additionalMilePrice });
    if (![price.basePrice, price.includedMiles, price.additionalMilePrice, price.total].every(value => value.isFinite())) return null;
    const displayedBase = price.basePrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      total: price.total.toFixed(2),
      basePrice: displayedBase.toFixed(2),
      includedMiles: price.includedMiles.toString(),
      additionalMiles: price.additionalMiles.toFixed(2),
      additionalMilePrice: price.additionalMilePrice.toString(),
      // Allocate rounding to the mileage charge so the displayed components add up to the actual standard total.
      additionalMileageCharge: price.subtotal.minus(displayedBase).toFixed(2),
    };
  } catch {
    // Coverage is still known when a warehouse pricing parameter is invalid.
    return null;
  }
}

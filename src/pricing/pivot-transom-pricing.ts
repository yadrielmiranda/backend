import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';

const label = (value: unknown) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').toUpperCase()
  : '';

export function isPivotTransomPricingCandidate(family: unknown, configuration: unknown): boolean {
  return family === 'PIVOT_DOOR' && label(configuration).replace(/\s*\/\s*/g, '/') === 'O/X';
}

/**
 * The reviewed Serie 1500 O/X SGP tariff prices the complete door/transom from
 * door dimensions. This exception is deliberately restricted to this catalog
 * identity; it does not change dimension policies, other glass or other series.
 */
export function usesPivot1500SgpDoorPricing(catalog: {
  brand: unknown; system: unknown; crystal: unknown;
}): boolean {
  return label(catalog.brand) === 'ECO WINDOWS SYSTEMS'
    && label(catalog.system) === 'SERIE 1500'
    && label(catalog.crystal) === '7/16 LAM [3/16 HS + .090 SGP + 3/16 HS]';
}

export function pivotTransomDoorPricingDimensions(
  widthIn: Decimal,
  openingHeightIn: Decimal,
  doorHeight: unknown,
): { widthIn: Decimal; heightIn: Decimal } {
  let heightIn: Decimal;
  try {
    heightIn = new Decimal(String(doorHeight ?? ''));
  } catch {
    throw new BadRequestException('Door Height is required for Serie 1500 O/X pricing.');
  }
  if (!heightIn.isFinite() || heightIn.lte(0)) {
    throw new BadRequestException('Door Height must be greater than zero for Serie 1500 O/X pricing.');
  }
  const transomHeightIn = openingHeightIn.minus(heightIn);
  if (transomHeightIn.lt(12) || transomHeightIn.gt(36)) {
    throw new BadRequestException('Serie 1500 O/X pricing requires a Transom Height (Opening Height - Door Height) between 12 and 36 inches, inclusive.');
  }
  return { widthIn, heightIn };
}

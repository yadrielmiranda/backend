import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

type StoredDecimal = string | number | { toString(): string };

export type FrameBaseModifier = {
  modifierEnabled?: boolean;
  basePriceMultiplier?: StoredDecimal | null;
  basePriceDeduction?: StoredDecimal | null;
};

/** Adjust one complete piece's base, before other options, margins or quantity. */
function applyBaseModifier(
  basePrice: Decimal,
  modifier: FrameBaseModifier | null,
  option: string,
  settingsPage: string,
): Decimal {
  if (modifier?.modifierEnabled !== true) return basePrice;

  let multiplier: Decimal;
  let deduction: Decimal;
  try {
    multiplier = new Decimal(modifier.basePriceMultiplier?.toString() ?? 'NaN');
    deduction = new Decimal(modifier.basePriceDeduction?.toString() ?? 'NaN');
  } catch {
    throw new BadRequestException(`The ${option} modifier has invalid values. Review it in ${settingsPage}.`);
  }

  if (!multiplier.isFinite() || multiplier.lte(0) || !deduction.isFinite() || deduction.lt(0)) {
    throw new BadRequestException(`The ${option} modifier requires a positive multiplier and a deduction of zero or greater. Review it in ${settingsPage}.`);
  }

  const adjustedBasePrice = basePrice.mul(multiplier).sub(deduction);
  if (!adjustedBasePrice.isFinite() || adjustedBasePrice.lt(0)) {
    throw new BadRequestException(`The ${option} modifier produces an invalid or negative base price for this piece. Review its multiplier and deduction in ${settingsPage}.`);
  }
  return adjustedBasePrice;
}

export function applyFrameBaseModifier(basePrice: Decimal, modifier: FrameBaseModifier): Decimal {
  return applyBaseModifier(basePrice, modifier, 'frame color', 'Manage Frame Colors');
}

export function applyDesignBaseModifier(basePrice: Decimal, modifier: FrameBaseModifier | null): Decimal {
  return applyBaseModifier(basePrice, modifier, 'design color', 'Manage Designs');
}

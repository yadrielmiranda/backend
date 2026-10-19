import { BadRequestException } from '@nestjs/common';

type ProductPolicy = { allowBaseUnitOperations?: boolean };
type PresentationPolicy = { isBase?: boolean; multiplier: number };

/** Base quantities remain valid for counts and repacking, even when daily work uses packages only. */
export function allowsMaterialDailyOperation(product: ProductPolicy, presentation: PresentationPolicy) {
  return product.allowBaseUnitOperations !== false || (!presentation.isBase && presentation.multiplier > 1);
}

export function assertMaterialDailyOperation(product: ProductPolicy, presentation: PresentationPolicy) {
  if (!allowsMaterialDailyOperation(product, presentation))
    throw new BadRequestException('This material is handled in complete packages only. Select a box, bag or another package instead of the base unit.');
}

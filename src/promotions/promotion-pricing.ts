import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';

export type PromotionTerms = {
  id: number;
  version: number;
  name: string;
  percent: string;
  startsAt: string;
  endsAt: string;
  brandId: number | null;
  productId: number | null;
  systemId: number | null;
  brandName?: string | null;
  productName?: string | null;
  systemName?: string | null;
};
export const expiredPromotionMessage =
  'This promotion has expired. Recalculate your estimate to continue.';
export function promotionTerms(value: unknown): PromotionTerms[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is PromotionTerms =>
      !!v &&
      typeof v === 'object' &&
      Number(v.percent) > 0 &&
      Number(v.percent) <= 100 &&
      Number.isFinite(Date.parse(v.endsAt)),
  );
}
export function savedPromotions(
  estimate: { promotionContext?: unknown; promotionLockedAt?: unknown },
  now = Date.now(),
) {
  return promotionTerms(estimate.promotionContext).filter(
    (p) => estimate.promotionLockedAt || Date.parse(p.endsAt) > now,
  );
}
export function promotionDeadline(
  pieces: Array<{ promotionSnapshot?: unknown }>,
): Date | null {
  const ends = pieces.flatMap((p) =>
    promotionTerms(p.promotionSnapshot ? [p.promotionSnapshot] : []).map((v) =>
      Date.parse(v.endsAt),
    ),
  );
  return ends.length ? new Date(Math.min(...ends)) : null;
}
export function effectiveExpiry(
  standard: Date | null,
  promotional: Date | null,
) {
  return standard && promotional
    ? new Date(Math.min(+standard, +promotional))
    : (standard ?? promotional);
}
export function promotionExpired(
  estimate: {
    promotionExpiresAt?: Date | string | null;
    expiresAt?: Date | string | null;
    promotionLockedAt?: unknown;
  },
  now = Date.now(),
) {
  return (
    !estimate.promotionLockedAt &&
    !!estimate.promotionExpiresAt &&
    Math.min(
      +new Date(estimate.promotionExpiresAt),
      estimate.expiresAt ? +new Date(estimate.expiresAt) : Infinity,
    ) <= now
  );
}
export function checkoutPromotionExpiry(
  estimate: Parameters<typeof promotionExpired>[0],
  now = Date.now(),
) {
  if (!estimate.promotionExpiresAt || estimate.promotionLockedAt)
    return undefined;
  if (promotionExpired(estimate, now))
    throw new BadRequestException(expiredPromotionMessage);
  const end = Math.min(
    +new Date(estimate.promotionExpiresAt),
    estimate.expiresAt ? +new Date(estimate.expiresAt) : Infinity,
    now + 86400000,
  );
  if (end - now < 1810000)
    throw new BadRequestException(
      'This promotion is too close to expiry to start a new card checkout. Contact us for assistance.',
    );
  return Math.floor(end / 1000);
}
export function applyPromotion<
  T extends {
    idBrand: number;
    idProd: number;
    idSyst: number;
    qty: number;
    price: Decimal;
    customerPrice: Decimal;
    rate: Decimal;
    subtotal: Decimal;
    customerSubtotal: Decimal;
    netProfit: Decimal;
    netProfitD: Decimal;
  },
>(piece: T, eligible: PromotionTerms[] = []) {
  const promotion = eligible
    .filter(
      (p) =>
        (!p.brandId || p.brandId === piece.idBrand) &&
        (!p.productId || p.productId === piece.idProd) &&
        (!p.systemId || p.systemId === piece.idSyst),
    )
    .sort((a, b) => Number(b.percent) - Number(a.percent) || a.id - b.id)[0];
  const originals = {
    regularPrice: piece.price,
    regularCustomerPrice: piece.customerPrice,
    promotionSnapshot: promotion ?? null,
  };
  if (!promotion) return { ...piece, ...originals };
  const factor = new Decimal(1).sub(new Decimal(promotion.percent).div(100));
  const price = piece.price
    .mul(factor)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const customerPrice = piece.customerPrice
    .mul(factor)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const subtotal = price.mul(piece.qty);
  const customerSubtotal = customerPrice.mul(piece.qty);
  return {
    ...piece,
    ...originals,
    price,
    customerPrice,
    subtotal,
    customerSubtotal,
    netProfit: price.sub(piece.rate),
    netProfitD: customerSubtotal.sub(subtotal),
  };
}

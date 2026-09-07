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
  excludedProductIds?: number[];
  excludedSystemIds?: number[];
  excludedProductNames?: string[];
  excludedSystemNames?: string[];
  automaticDealerAdjustment?: boolean;
  // Guarda la proporción exacta por importes, sin depender de un porcentaje
  // periódico. Las condiciones antiguas sin esta base conservan su porcentaje.
  dealerPriceBasis?: { regularPrice: string; promotionalPrice: string };
  // Solo se usa al calcular; no se guarda en la pieza ni se envía al usuario.
  clientReferenceMarkup?: string;
};

const ExactPrice = Decimal.clone({ precision: 40 });
function discountedPrice(amount: Decimal, promotion: PromotionTerms) {
  const basis = promotion.automaticDealerAdjustment
    ? promotion.dealerPriceBasis
    : undefined;
  if (basis) {
    // Multiplica antes de dividir para conservar los empates de medio centavo.
    return new Decimal(
      new ExactPrice(amount.toString())
        .mul(basis.promotionalPrice)
        .div(basis.regularPrice)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toString(),
    );
  }
  return amount
    .mul(new Decimal(1).sub(new Decimal(promotion.percent).div(100)))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
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
>(piece: T, eligible: PromotionTerms[] = [], pricingRate = piece.rate) {
  const matching = eligible.filter(
    (p) =>
      (!p.brandId || p.brandId === piece.idBrand) &&
      (!p.productId || p.productId === piece.idProd) &&
      (!p.systemId || p.systemId === piece.idSyst) &&
      !p.excludedProductIds?.includes(piece.idProd) &&
      !p.excludedSystemIds?.includes(piece.idSyst),
  );
  // Las ofertas directas conservan prioridad y el porcentaje configurado.
  const direct = matching.filter((p) => !p.automaticDealerAdjustment);
  const candidates = direct.length
    ? direct.map((promotion) => ({
        promotion,
        price: discountedPrice(piece.price, promotion),
      }))
    : matching.flatMap((p) => {
        if (p.clientReferenceMarkup === undefined)
          return [{ promotion: p, price: discountedPrice(piece.price, p) }];
        if (!piece.price.gt(0)) return [];
        const clientRegularPrice = pricingRate
          .mul(new Decimal(1).add(p.clientReferenceMarkup))
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const clientPromotionPrice = clientRegularPrice
          .mul(new Decimal(1).sub(new Decimal(p.percent).div(100)))
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (clientPromotionPrice.gte(piece.price)) return [];
        const price = Decimal.max(0, clientPromotionPrice);
        const percent = piece.price.sub(price).mul(100).div(piece.price);
        const { clientReferenceMarkup: _reference, ...terms } = p;
        return [
          {
            promotion: {
              ...terms,
              percent: percent.toString(),
              dealerPriceBasis: {
                regularPrice: piece.price.toString(),
                promotionalPrice: price.toString(),
              },
            },
            // El dealer recibe directamente el importe promocional del client.
            price,
          },
        ];
      });
  const selected = candidates.sort(
    (a, b) =>
      new Decimal(b.promotion.percent).cmp(a.promotion.percent) ||
      a.promotion.id - b.promotion.id,
  )[0];
  const promotion = selected?.promotion;
  const originals = {
    regularPrice: piece.price,
    regularCustomerPrice: piece.customerPrice,
    promotionSnapshot: promotion ?? null,
  };
  if (!promotion) return { ...piece, ...originals };
  const price = selected.price;
  const customerPrice = discountedPrice(piece.customerPrice, promotion);
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

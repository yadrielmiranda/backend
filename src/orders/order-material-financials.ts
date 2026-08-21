import { DealerAffiliation, DealerMode } from '@prisma/client';
import Decimal from 'decimal.js';

const money = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function resolveMaterialSaleSubtotal(params: {
  dealerMode: DealerMode | null;
  priceT: Decimal.Value;
  customerPriceT: Decimal.Value;
}) {
  return money(
    params.dealerMode === DealerMode.INTERNAL
      ? params.customerPriceT
      : params.priceT,
  );
}

export function resolveImpactMarkupRate(params: {
  dealerMode: DealerMode | null;
  dealerAffiliation: DealerAffiliation | null;
  ownerMarkupSnapshot: Decimal.Value;
  priceT: Decimal.Value;
  customerPriceT: Decimal.Value;
}) {
  if (params.dealerAffiliation !== DealerAffiliation.IMPACT) {
    return new Decimal(0);
  }

  if (params.dealerMode !== DealerMode.INTERNAL) {
    return new Decimal(params.ownerMarkupSnapshot);
  }

  const internalBasePrice = new Decimal(params.priceT);
  if (internalBasePrice.lte(0)) return new Decimal(0);

  // An internal dealer's pricing markup can exist (including a negative one),
  // but it is only an intermediate estimate adjustment. The material profit
  // split uses the effective markup applied from priceT to customerPriceT.
  return new Decimal(params.customerPriceT)
    .div(internalBasePrice)
    .minus(1)
    .toDecimalPlaces(18, Decimal.ROUND_HALF_UP);
}

export function calculateMaterialFinancials(params: {
  saleSubtotal: Decimal.Value;
  factoryRate: Decimal.Value;
  dealerAffiliation: DealerAffiliation | null;
  impactMarkupRate: Decimal.Value;
}) {
  const saleSubtotal = money(params.saleSubtotal);
  const factoryRate = money(params.factoryRate);
  const belongsToImpact = params.dealerAffiliation === DealerAffiliation.IMPACT;
  const impactMarkupRate = belongsToImpact
    ? new Decimal(params.impactMarkupRate)
    : new Decimal(0);
  const factoryPriceWithMarkup = money(
    factoryRate.mul(impactMarkupRate.add(1)),
  );
  const impactProfit = belongsToImpact
    ? money(factoryPriceWithMarkup.minus(factoryRate))
    : new Decimal(0);
  const authenticProfit = money(saleSubtotal.minus(factoryPriceWithMarkup));

  return {
    saleSubtotal,
    factoryRate,
    impactMarkupRate,
    factoryPriceWithMarkup,
    impactProfit,
    authenticProfit,
    totalProfit: money(saleSubtotal.minus(factoryRate)),
  };
}

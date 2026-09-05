import { DealerMode } from '@prisma/client';
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

export function calculateMaterialFinancials(params: {
  saleSubtotal: Decimal.Value;
  factoryRate: Decimal.Value;
}) {
  const saleSubtotal = money(params.saleSubtotal);
  const factoryRate = money(params.factoryRate);

  return {
    saleSubtotal,
    factoryRate,
    totalProfit: money(saleSubtotal.minus(factoryRate)),
  };
}

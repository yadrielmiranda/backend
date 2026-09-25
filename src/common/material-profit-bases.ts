import Decimal from 'decimal.js';

const money = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Bases monetarias comunes. El precio base de la app NO contiene ningún markup. */
export function calculateMaterialProfitBases(params: {
  customerPrice: Decimal.Value;
  appBasePrice: Decimal.Value;
  dealerPrice: Decimal.Value;
  realFactoryCost?: Decimal.Value | null;
  netProfitD?: Decimal.Value;
}) {
  const customerPrice = money(params.customerPrice);
  // Mantiene el redondeo monetario del resumen financiero de las órdenes.
  const expectedProfit = customerPrice.minus(money(params.appBasePrice));
  const realProfit = params.realFactoryCost == null
    ? null
    : customerPrice.minus(money(params.realFactoryCost));
  // Reutiliza el margen persistido cuando el llamador ya aplicó sus descuentos.
  const netProfitD = params.netProfitD == null
    ? customerPrice.minus(money(params.dealerPrice))
    : money(params.netProfitD);

  return { expectedProfit, realProfit, netProfitD };
}

export type MaterialProfitBases = ReturnType<typeof calculateMaterialProfitBases>;

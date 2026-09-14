import {
  calculateEstimateDiscount,
  estimateDiscountConfig,
} from '../discounts/estimate-discount';
import { buildEstimateInstallationSummary } from '../reporting/estimate-installation-summary';
import {
  buildEstimateCustomerChargeSummary,
  isExternalDealerEstimate,
} from '../estimate-customer-charges.summary';
import type { CustomerReportPricingMode } from '../dto/create-estimate-public-token.dto';

function numberValue(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Proyección compartida: no incluye costos, ganancias ni promociones privadas del dealer.
export function buildPublicEstimateData(
  estimate: any,
  branding: any,
  pieces: any[],
  pricingMode: CustomerReportPricingMode,
) {
  // La promoción del dealer externo es privada; el cliente recibe su cotización final.
  const hideDealerPromotions = isExternalDealerEstimate(estimate);
  const discount = hideDealerPromotions
    ? null
    : calculateEstimateDiscount(estimate);
  const customerDiscount = discount?.payer === 'CUSTOMER' ? discount : null;

  const fullInstallationSummary = buildEstimateInstallationSummary(
    estimate.installationJob,
  );
  const fullCustomerChargesSummary = buildEstimateCustomerChargeSummary({
    estimate,
    installation: fullInstallationSummary,
    charges: estimate.customerCharges ?? [],
  });
  const customerServiceTotal = fullCustomerChargesSummary
    ? numberValue(fullCustomerChargesSummary.customerTotal)
    : numberValue(fullInstallationSummary?.installationTotal) +
      (fullInstallationSummary?.permitIncluded
        ? numberValue(fullInstallationSummary.permitFee)
        : 0) +
      numberValue(fullInstallationSummary?.cityFee);
  const publicProjectTotalIncomplete = fullCustomerChargesSummary
    ? fullCustomerChargesSummary.customerTotalIncomplete
    : Boolean(
        fullInstallationSummary &&
          (fullInstallationSummary.installationTotal == null ||
            (fullInstallationSummary.permitIncluded &&
              fullInstallationSummary.cityFee == null)),
      );
  const publicProjectTotal = roundMoney(
    numberValue(
      customerDiscount?.material.total ?? estimate.customerTotalPayable,
    ) +
      customerServiceTotal -
      numberValue(customerDiscount?.installation.discount) -
      numberValue(customerDiscount?.permit.discount) -
      numberValue(customerDiscount?.city.discount),
  );
  // An external dealer's customer must never receive the company's
  // installation prices, even though the customer-facing report renders a
  // different summary. Keep status/scope metadata, but zero every internal
  // amount at the public API boundary.
  const hideSystemInstallationPrices = Boolean(fullCustomerChargesSummary);
  const installationSummary =
    (pricingMode === 'total' || hideSystemInstallationPrices) &&
    fullInstallationSummary
      ? {
          ...fullInstallationSummary,
          installationAmount:
            fullInstallationSummary.installationAmount == null ? null : '0.00',
          installationTotal:
            fullInstallationSummary.installationTotal == null ? null : '0.00',
          additionalServices: fullInstallationSummary.additionalServices.map(
            (service) => ({
              ...service,
              amount: '0.00',
            }),
          ),
          permitFee: fullInstallationSummary.permitFee == null ? null : '0.00',
          cityFee: fullInstallationSummary.cityFee == null ? null : '0.00',
        }
      : fullInstallationSummary;
  const customerChargesSummary = fullCustomerChargesSummary
    ? {
        ...fullCustomerChargesSummary,
        systemTotal: '0.00',
        knownSystemMargin: '0.00',
        dealerCreatedTotal: '0.00',
        customerTotal:
          pricingMode === 'total'
            ? '0.00'
            : fullCustomerChargesSummary.customerTotal,
        lines: fullCustomerChargesSummary.lines
          .filter((line) => line.usedInCustomerQuote)
          .map((line) => ({
            id: null,
            origin: 'DEALER' as const,
            source: 'CUSTOM' as const,
            sourceKey: null,
            sourceRefId: null,
            description: line.description,
            systemAmount: null,
            customerAmount:
              pricingMode === 'total' ? '0.00' : line.customerAmount,
            pricingMode: null,
            pricingValue: null,
            usedInCustomerQuote: true,
            needsReview: false,
            sortOrder: line.sortOrder,
          })),
      }
    : null;

  return {
    id: estimate.id,
    number: estimate.number,
    name: estimate.name,
    date: estimate.date,
    expiresAt: estimate.expiresAt,
    status: estimate.status,

    customerFirstName: estimate.customerFirstName,
    customerLastName: estimate.customerLastName,
    customerEmail: estimate.customerEmail,
    customerPhone: estimate.customerPhone,
    customerStreet: estimate.customerStreet,
    customerCity: estimate.customerCity,
    customerState: estimate.customerState,
    customerPostalCode: estimate.customerPostalCode,

    manualDiscountSummary:
      pricingMode === 'total' ? undefined : (customerDiscount ?? undefined),
    customerPromotionsVisible: !hideDealerPromotions,
    termsPreservedAfterPayment: Boolean(
      estimate.promotionLockedAt ||
        estimateDiscountConfig(estimate.manualDiscount)?.lockedAt,
    ),
    promotionExpiresAt: hideDealerPromotions
      ? undefined
      : estimate.promotionExpiresAt,
    promotionLockedAt: hideDealerPromotions
      ? undefined
      : estimate.promotionLockedAt,
    customerDiscountAmount: hideDealerPromotions
      ? undefined
      : pricingMode === 'total'
        ? 0
        : estimate.customerDiscountAmount,
    originalCustomerPriceT: hideDealerPromotions
      ? undefined
      : pricingMode === 'total'
        ? 0
        : estimate.originalCustomerPriceT,
    customerPriceT: pricingMode === 'total' ? 0 : estimate.customerPriceT,
    customerTaxRate: pricingMode === 'total' ? 0 : estimate.customerTaxRate,
    customerTaxAmount: pricingMode === 'total' ? 0 : estimate.customerTaxAmount,
    customerTotalPayable:
      pricingMode === 'total' ? 0 : estimate.customerTotalPayable,

    installationSummary,
    customerChargesSummary,
    publicPricingMode: pricingMode,
    publicProjectTotal:
      pricingMode === 'total' ? publicProjectTotal : undefined,
    publicProjectTotalIncomplete:
      pricingMode === 'total' ? publicProjectTotalIncomplete : undefined,

    branding,

    pieces: pieces.map((p) => ({
      id: p.id,
      mark: p.mark,
      qty: p.qty,

      width: p.width,
      height: p.height,
      heightLeft: p.heightLeft,
      heightRight: p.heightRight,
      legHeight: p.legHeight,
      sashHeight: p.sashHeight,
      windowHeight: p.windowHeight,

      doorWidth: p.doorWidth,
      doorHeight: p.doorHeight,
      leftSideliteWidth: p.leftSideliteWidth,
      rightSideliteWidth: p.rightSideliteWidth,
      leftPanels: p.leftPanels,
      rightPanels: p.rightPanels,
      panelCount: p.panelCount,
      horizontalHeights: p.horizontalHeights,

      idProd: p.idProd,
      idBrand: p.idBrand,
      idSyst: p.idSyst,
      idConf: p.idConf,
      idFC: p.idFC,
      idCryst: p.idCryst,
      idTint: p.idTint,
      idCoat: p.idCoat,
      idPrivacy: p.idPrivacy,

      screen: p.screen,
      highBottom: p.highBottom,
      highBottomPercent: p.highBottomPercent,

      dpPosPsf: p.dpPosPsf,
      dpNegPsf: p.dpNegPsf,

      customerPrice: pricingMode === 'total' ? 0 : p.customerPrice,
      customerSubtotal: pricingMode === 'total' ? 0 : p.customerSubtotal,
      // El cliente de un dealer externo nunca recibe el precio previo a la promoción.
      regularCustomerPrice:
        hideDealerPromotions || pricingMode === 'total' || !p.promotionSnapshot
          ? undefined
          : p.regularCustomerPrice,

      prod: p.prod,
      bran: p.bran,
      syst: p.syst,
      conf: p.conf,
      fColor: p.fColor,
      cryst: p.cryst,
      tin: p.tin,
      coat: p.coat,
      privacyOption: p.privacyOption,

      activeOption: p.activeOption,
      preparationOption: p.preparationOption,
      sillOption: p.sillOption,
      reinforcementOption: p.reinforcementOption,

      pieceMuntin: p.pieceMuntin,
      diagramMetadata: p.diagramMetadata,
    })),
  };
}

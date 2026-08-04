import {
  InstallationJobStatus,
  InstallationPermitStatus,
} from "@prisma/client";
import Decimal from "decimal.js";

export function canViewAllInstallations(
  roleName: string | null | undefined,
): boolean {
  return roleName === "admin";
}

export function installationSearchTokens(search: string | undefined): string[] {
  return (search ?? "")
    .trim()
    .replace(/\b(?:order|estimate)\s*#?/gi, " ")
    .replace(/#/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function decimalOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  try {
    return new Decimal(String(value)).toString();
  } catch {
    return String(value);
  }
}

function integerOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

type InstallationMeasurementPricingInput = {
  widthIn?: unknown;
  heightIn?: unknown;
  heightLeftIn?: unknown;
  heightRightIn?: unknown;
  legHeightIn?: unknown;
  panelCount?: unknown;
  lengthIn?: unknown;
};

export function didInstallationMeasurementPricingInputChange(
  current: InstallationMeasurementPricingInput,
  updates: InstallationMeasurementPricingInput,
): boolean {
  const decimalFields = [
    "widthIn",
    "heightIn",
    "heightLeftIn",
    "heightRightIn",
    "legHeightIn",
    "lengthIn",
  ] as const;

  if (
    decimalFields.some(
      (field) =>
        updates[field] !== undefined &&
        decimalOrNull(updates[field]) !== decimalOrNull(current[field]),
    )
  ) {
    return true;
  }

  return (
    updates.panelCount !== undefined &&
    integerOrNull(updates.panelCount) !== integerOrNull(current.panelCount)
  );
}

function canonicalMuntin(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const muntin = value as Record<string, unknown>;
  const panels = Array.isArray(muntin.panels)
    ? muntin.panels
        .map((value) => value as Record<string, unknown>)
        .map((panel) => ({
          panelIndex: integerOrNull(panel.panelIndex),
          panelCode: panel.panelCode == null ? null : String(panel.panelCode),
          panelLabel:
            panel.panelLabel == null ? null : String(panel.panelLabel),
          horizontalLites: integerOrNull(panel.horizontalLites),
          verticalLites: integerOrNull(panel.verticalLites),
        }))
        .sort(
          (left, right) =>
            (left.panelIndex ?? 0) - (right.panelIndex ?? 0),
        )
    : [];
  return {
    idPattern: integerOrNull(muntin.idPattern),
    idType: integerOrNull(muntin.idType),
    panels,
  };
}

/**
 * Produces a stable identity for one physical Piece proposal. Display-only
 * values such as mark and qty are intentionally excluded so equal measured
 * units can remain grouped in the Estimate.
 */
export function createEstimateRevisionPieceFingerprint(
  input: object,
  pricing?: object | null,
): string {
  const piece = input as Record<string, unknown>;
  const price = pricing as Record<string, unknown> | null | undefined;
  const dimensions = [
    "width",
    "height",
    "heightLeft",
    "heightRight",
    "legHeight",
    "sashHeight",
    "windowHeight",
    "doorWidth",
    "doorHeight",
    "leftSideliteWidth",
    "rightSideliteWidth",
  ] as const;
  const canonicalDimensions = Object.fromEntries(
    dimensions.map((key) => [key, decimalOrNull(piece[key])]),
  );

  return JSON.stringify({
    piece: {
      idProd: integerOrNull(piece.idProd),
      idBrand: integerOrNull(piece.idBrand),
      idSyst: integerOrNull(piece.idSyst),
      idConf: integerOrNull(piece.idConf),
      idFC: integerOrNull(piece.idFC),
      ...canonicalDimensions,
      leftPanels: integerOrNull(piece.leftPanels),
      rightPanels: integerOrNull(piece.rightPanels),
      panelCount: integerOrNull(piece.panelCount),
      horizontalHeights: Array.isArray(piece.horizontalHeights)
        ? piece.horizontalHeights.map(decimalOrNull)
        : null,
      idCryst: integerOrNull(piece.idCryst),
      idTint: integerOrNull(piece.idTint),
      privacy: Boolean(piece.privacy),
      idCoat: integerOrNull(piece.idCoat),
      screen: Boolean(piece.screen),
      highBottom: Boolean(piece.highBottom),
      idActiveOption: integerOrNull(piece.idActiveOption),
      idPreparationOption: integerOrNull(piece.idPreparationOption),
      idSillOption: integerOrNull(piece.idSillOption),
      idReinforcementOption: integerOrNull(piece.idReinforcementOption),
      muntin: canonicalMuntin(piece.muntin),
      dealerMarkup: decimalOrNull(piece.dealerMarkup),
    },
    pricing: price
      ? {
          rate: decimalOrNull(price.rate),
          price: decimalOrNull(price.price),
          customerPrice: decimalOrNull(price.customerPrice),
          dealerMarkupDecimal: decimalOrNull(price.dealerMarkupDecimal),
        }
      : null,
  });
}

export function calculateInstallationBalance(
  installationTotal: Decimal.Value,
  paidCredits: Decimal.Value[],
): Decimal {
  const credits = paidCredits.reduce<Decimal>(
    (sum, credit) => sum.add(credit),
    new Decimal(0),
  );
  return Decimal.max(0, new Decimal(installationTotal).minus(credits));
}

export function canOwnerEditInstallationEstimate(
  status: InstallationJobStatus,
  depositCheckoutStarted: boolean,
): boolean {
  return (
    status === InstallationJobStatus.CANCELED ||
    (status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING &&
      !depositCheckoutStarted)
  );
}

export function resolveApprovedPreOrderStage(
  permit: {
    status: InstallationPermitStatus;
    cityFee: unknown | null;
  } | null,
): InstallationJobStatus {
  if (!permit) return InstallationJobStatus.MATERIAL_PAYMENT_PENDING;
  if (permit.status === InstallationPermitStatus.PAYMENT_PENDING) {
    return InstallationJobStatus.PERMIT_PAYMENT_PENDING;
  }
  if (
    permit.status === InstallationPermitStatus.APPROVED &&
    permit.cityFee != null
  ) {
    return InstallationJobStatus.MATERIAL_PAYMENT_PENDING;
  }
  return InstallationJobStatus.PERMIT_PROCESSING;
}

export function nextManualOrderStatus(currentStatus: string): string | null {
  const transitions: Record<string, string | null> = {
    Pending: "In production",
    "In production": "Ready to pick up",
    "Ready to pick up": "Delivered",
    Delivered: null,
    "Installation in progress": null,
    Installed: null,
  };
  return transitions[currentStatus] ?? null;
}

export function canCreateInstallationExtraCharge(orderStatus: string): boolean {
  return ["Delivered", "Installation in progress", "Installed"].includes(
    orderStatus,
  );
}

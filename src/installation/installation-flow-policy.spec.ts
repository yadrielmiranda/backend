import {
  InstallationJobStatus,
  InstallationPermitStatus,
} from "@prisma/client";
import {
  calculateInstallationBalance,
  canViewAllInstallations,
  canOwnerEditInstallationEstimate,
  canCreateInstallationExtraCharge,
  createEstimateRevisionPieceFingerprint,
  didInstallationMeasurementPricingInputChange,
  nextManualOrderStatus,
  installationSearchTokens,
  resolveApprovedPreOrderStage,
} from "./installation-flow-policy";

describe("installation flow policy", () => {
  it("allows only admins to view every installation", () => {
    expect(canViewAllInstallations("admin")).toBe(true);
    expect(canViewAllInstallations("operator")).toBe(false);
    expect(canViewAllInstallations("dealer")).toBe(false);
    expect(canViewAllInstallations("client")).toBe(false);
  });

  it("normalizes reference searches and supports customer-name tokens", () => {
    expect(installationSearchTokens("Order #1204")).toEqual(["1204"]);
    expect(installationSearchTokens("Estimate #E-900")).toEqual(["E-900"]);
    expect(installationSearchTokens("  Ana   Maria  ")).toEqual([
      "Ana",
      "Maria",
    ]);
  });

  it("does not require quote recalculation when measured pricing inputs are numerically unchanged", () => {
    expect(
      didInstallationMeasurementPricingInputChange(
        { widthIn: "42.000", heightIn: "62", panelCount: 3 },
        { widthIn: 42, heightIn: 62.0, panelCount: 3 },
      ),
    ).toBe(false);
  });

  it("requires quote recalculation when a measured pricing input changes", () => {
    expect(
      didInstallationMeasurementPricingInputChange(
        { widthIn: "42", heightIn: "62", panelCount: 3 },
        { widthIn: 43, heightIn: 62, panelCount: 3 },
      ),
    ).toBe(true);
    expect(
      didInstallationMeasurementPricingInputChange(
        { widthIn: "42", heightIn: "62", panelCount: 3 },
        { panelCount: 4 },
      ),
    ).toBe(true);
  });

  it("credits the non-refundable deposit toward installation exactly once", () => {
    expect(calculateInstallationBalance(2500, [300]).toFixed(2)).toBe(
      "2200.00",
    );
    expect(calculateInstallationBalance(2500, [300, 2200]).toFixed(2)).toBe(
      "0.00",
    );
    expect(calculateInstallationBalance(250, [300]).toFixed(2)).toBe("0.00");
  });

  it("allows owner edits only before deposit checkout or after cancellation", () => {
    expect(
      canOwnerEditInstallationEstimate(
        InstallationJobStatus.DEPOSIT_PAYMENT_PENDING,
        false,
      ),
    ).toBe(true);
    expect(
      canOwnerEditInstallationEstimate(
        InstallationJobStatus.DEPOSIT_PAYMENT_PENDING,
        true,
      ),
    ).toBe(false);
    expect(
      canOwnerEditInstallationEstimate(
        InstallationJobStatus.MEASUREMENT_SCHEDULING,
        false,
      ),
    ).toBe(false);
    expect(
      canOwnerEditInstallationEstimate(
        InstallationJobStatus.CANCELED,
        true,
      ),
    ).toBe(true);
  });

  it("routes an approved remeasurement through Permit before material", () => {
    expect(
      resolveApprovedPreOrderStage({
        status: InstallationPermitStatus.PAYMENT_PENDING,
        cityFee: null,
      }),
    ).toBe(InstallationJobStatus.PERMIT_PAYMENT_PENDING);

    expect(
      resolveApprovedPreOrderStage({
        status: InstallationPermitStatus.SUBMITTED,
        cityFee: null,
      }),
    ).toBe(InstallationJobStatus.PERMIT_PROCESSING);

    expect(
      resolveApprovedPreOrderStage({
        status: InstallationPermitStatus.APPROVED,
        cityFee: 250,
      }),
    ).toBe(InstallationJobStatus.MATERIAL_PAYMENT_PENDING);
  });

  it("skips Permit stages when no company Permit was requested", () => {
    expect(resolveApprovedPreOrderStage(null)).toBe(
      InstallationJobStatus.MATERIAL_PAYMENT_PENDING,
    );
  });

  it("keeps manual order transitions sequential and reserves installation states", () => {
    expect(nextManualOrderStatus("Pending")).toBe("In production");
    expect(nextManualOrderStatus("In production")).toBe("Ready to pick up");
    expect(nextManualOrderStatus("Ready to pick up")).toBe("Delivered");
    expect(nextManualOrderStatus("Delivered")).toBeNull();
    expect(nextManualOrderStatus("Installation in progress")).toBeNull();
  });

  it("allows extra charges only after delivery", () => {
    expect(canCreateInstallationExtraCharge("Ready to pick up")).toBe(false);
    expect(canCreateInstallationExtraCharge("Delivered")).toBe(true);
    expect(canCreateInstallationExtraCharge("Installation in progress")).toBe(
      true,
    );
    expect(canCreateInstallationExtraCharge("Installed")).toBe(true);
  });

  it("keeps physically equal remeasured units grouped", () => {
    const first = createEstimateRevisionPieceFingerprint({
      mark: "W1",
      qty: 2,
      idProd: 1,
      idBrand: 2,
      idSyst: 3,
      idConf: 4,
      idFC: 5,
      width: "42.000",
      height: "62.0",
      idPrivacy: undefined,
      screen: false,
      horizontalHeights: ["18.00", 24],
    });
    const second = createEstimateRevisionPieceFingerprint({
      mark: "W99",
      qty: 1,
      idProd: 1,
      idBrand: 2,
      idSyst: 3,
      idConf: 4,
      idFC: 5,
      width: "42",
      height: "62",
      idPrivacy: null,
      horizontalHeights: [18, "24.000"],
    });

    expect(first).toBe(second);
  });

  it("splits units when dimensions, configuration, or unit price differ", () => {
    const base = {
      idProd: 1,
      idBrand: 2,
      idSyst: 3,
      idConf: 4,
      idFC: 5,
      width: "42",
      height: "62",
    };
    const basePricing = {
      rate: "400",
      price: "600",
      customerPrice: "700",
      dealerMarkupDecimal: "0.1",
    };

    expect(
      createEstimateRevisionPieceFingerprint(base, basePricing),
    ).not.toBe(
      createEstimateRevisionPieceFingerprint(
        { ...base, width: "43" },
        basePricing,
      ),
    );
    expect(
      createEstimateRevisionPieceFingerprint(base, basePricing),
    ).not.toBe(
      createEstimateRevisionPieceFingerprint(
        { ...base, idConf: 9 },
        basePricing,
      ),
    );
    expect(
      createEstimateRevisionPieceFingerprint(base, basePricing),
    ).not.toBe(
      createEstimateRevisionPieceFingerprint(base, {
        ...basePricing,
        customerPrice: "701",
      }),
    );
  });
});

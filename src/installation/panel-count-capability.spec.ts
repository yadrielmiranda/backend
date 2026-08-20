import {
  InstallationBillingUnit,
  InstallationRuleMetric,
} from "@prisma/client";
import {
  hasPanelCountSource,
  installationServiceRequiresPanelCount,
} from "./panel-count-capability";

describe("installation panel-count capability", () => {
  it("requires panel count when the service bills by panel", () => {
    expect(
      installationServiceRequiresPanelCount({
        billingUnit: InstallationBillingUnit.PANEL,
        ruleMetric: InstallationRuleMetric.NONE,
      }),
    ).toBe(true);
  });

  it("requires panel count when the service selects its rate by panel count", () => {
    expect(
      installationServiceRequiresPanelCount({
        billingUnit: InstallationBillingUnit.UNIT,
        ruleMetric: InstallationRuleMetric.PANEL_COUNT,
      }),
    ).toBe(true);
  });

  it("accepts a positive fixed panel count", () => {
    expect(
      hasPanelCountSource({
        fixedPanelCount: 3,
        requiresPanelCount: false,
      }),
    ).toBe(true);
  });

  it("accepts the manual panel-count fallback", () => {
    expect(
      hasPanelCountSource({
        fixedPanelCount: null,
        requiresPanelCount: true,
      }),
    ).toBe(true);
  });

  it("rejects a configuration without either source", () => {
    expect(
      hasPanelCountSource({
        fixedPanelCount: null,
        requiresPanelCount: false,
      }),
    ).toBe(false);
  });
});

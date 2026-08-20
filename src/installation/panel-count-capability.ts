import {
  InstallationBillingUnit,
  InstallationRuleMetric,
} from "@prisma/client";

export type InstallationPanelCountService = {
  billingUnit: InstallationBillingUnit;
  ruleMetric: InstallationRuleMetric;
};

export type PanelCountSource = {
  fixedPanelCount?: number | null;
  requiresPanelCount?: boolean | null;
};

export function installationServiceRequiresPanelCount(
  service: InstallationPanelCountService,
): boolean {
  return (
    service.billingUnit === InstallationBillingUnit.PANEL ||
    service.ruleMetric === InstallationRuleMetric.PANEL_COUNT
  );
}

export function hasPanelCountSource({
  fixedPanelCount,
  requiresPanelCount,
}: PanelCountSource): boolean {
  const configuredValue = Number(fixedPanelCount);

  return (
    (Number.isInteger(configuredValue) && configuredValue >= 1) ||
    requiresPanelCount === true
  );
}

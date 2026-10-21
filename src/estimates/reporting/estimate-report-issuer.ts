import {
  isExternalDealerEstimate,
  type EstimateClassification,
} from '../estimate-customer-charges.summary';

export type ExternalDealerPresentation = {
  name: string;
  phone: string | null;
  email: string | null;
};

type EstimateIssuerSource = EstimateClassification & {
  user: EstimateClassification['user'] & {
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    email?: string | null;
  };
};

// The owner issues the quote; Company branding only supplies the platform logo.
// Agreement creation may freeze this projection; never infer it from public snapshots.
export function buildExternalDealerPresentation(
  estimate: EstimateIssuerSource,
  branding: { type?: string; isActive?: boolean } | null | undefined,
): ExternalDealerPresentation | null {
  if (
    !isExternalDealerEstimate(estimate) ||
    (branding?.type === 'DEALER' && branding.isActive !== false)
  ) {
    return null;
  }

  const name = [estimate.user.firstName, estimate.user.lastName]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' ');

  return {
    name: name || 'Independent Distributor',
    phone: estimate.user.phone?.trim() || null,
    email: estimate.user.email?.trim() || null,
  };
}

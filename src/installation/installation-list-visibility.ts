import { InstallationJobStatus, InstallationPermitStatus, Prisma } from '@prisma/client';
import { CANCELED_ESTIMATE } from '@/estimates/estimate-lifecycle-policy';

// Only the list uses this filter. Preliminary requests remain accessible from
// their estimate and detail page. Workflow stages, rather than an open checkout
// or an individual partial payment, establish that work has begun.
export function operationalInstallationListWhere(): Prisma.InstallationJobWhereInput {
  return {
    OR: [
      { estimate: { order: { isNot: null } } },
      {
        permit: {
          is: {
            OR: [
              { status: { not: InstallationPermitStatus.PAYMENT_PENDING } },
              { paidAt: { not: null } },
              { submittedAt: { not: null } },
              { approvedAt: { not: null } },
            ],
          },
        },
      },
      // Accepting dealer measurements marks them completed without measuredAt.
      // An actual visit keeps a job visible even during a later quote revision.
      { measurements: { some: { measuredAt: { not: null } } } },
      {
        status: {
          in: [
            InstallationJobStatus.MEASUREMENT_SCHEDULING,
            InstallationJobStatus.MEASUREMENT_SCHEDULED,
            InstallationJobStatus.MEASUREMENT_PENDING,
            InstallationJobStatus.PERMIT_PROCESSING,
            InstallationJobStatus.MATERIAL_PAID,
            InstallationJobStatus.INSTALLATION_PAYMENT_PENDING,
            InstallationJobStatus.INSTALLATION_PAID,
            InstallationJobStatus.SCHEDULING,
            InstallationJobStatus.SCHEDULED,
            InstallationJobStatus.IN_PROGRESS,
            InstallationJobStatus.COMPLETED,
            InstallationJobStatus.CANCELED,
          ],
        },
      },
      {
        // In the normal flow these stages follow the completed deposit and
        // remeasurement. A waiver can reach them before the customer commits.
        dealerMeasurementsAcceptedAt: null,
        status: {
          in: [
            InstallationJobStatus.QUOTE_DRAFT,
            InstallationJobStatus.ADMIN_APPROVAL_PENDING,
            InstallationJobStatus.CUSTOMER_APPROVAL_PENDING,
            InstallationJobStatus.APPROVED,
            InstallationJobStatus.PERMIT_PAYMENT_PENDING,
            InstallationJobStatus.MATERIAL_PAYMENT_PENDING,
          ],
        },
      },
      // Keep the existing canceled-estimate history available in Canceled/All.
      { estimate: { status: { name: CANCELED_ESTIMATE } } },
    ],
  };
}

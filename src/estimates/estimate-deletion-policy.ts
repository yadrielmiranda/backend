import { InstallationJobStatus } from '@prisma/client';
import { canEditUnpaidWaivedInstallation } from '@/installation/installation-flow-policy';

type WaivedInstallation = Parameters<typeof canEditUnpaidWaivedInstallation>[0];
type Installation = Pick<WaivedInstallation, 'status'> &
  Partial<Pick<WaivedInstallation, 'dealerMeasurementsAcceptedAt' | 'quotes'>> & {
    _count?: { quotes: number };
  };

// Only the initial calculation can be discarded together with an unpaid estimate.
// The caller must separately protect payment history, checkouts and signed agreements.
export function canDeleteEstimateInstallation(
  estimate: WaivedInstallation['estimate'],
  job: Installation | null | undefined,
): boolean {
  if (!job || job.status === InstallationJobStatus.CANCELED) return true;
  if (job.status === InstallationJobStatus.DEPOSIT_PAYMENT_PENDING) return true;
  return job._count?.quotes === 1 && canEditUnpaidWaivedInstallation({
    ...job,
    dealerMeasurementsAcceptedAt: job.dealerMeasurementsAcceptedAt ?? null,
    quotes: job.quotes ?? [],
    estimate,
  });
}

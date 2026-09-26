import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paidPrincipal, paymentIsCovered } from '@/payments/payment-accounting';

export const OPEN_MATERIAL_REVISION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'AWAITING_SIGNATURE'] as const;
export const MATERIAL_REVISION_PENDING_MESSAGE = 'Finish or cancel the pending material revision before continuing.';

// La ausencia de PO por sí sola no prueba que una orden no se haya enviado.
// Además de estas comprobaciones se registra la confirmación explícita del personal.
export function isBeforeFactory(estimate: any): boolean {
  const order = estimate?.order;
  return !order || (order.status?.name === 'Pending' && !order.poNumber?.trim() && order.rateReal == null &&
    !(estimate.pieces ?? []).some((piece: any) => (piece.factoryUnits?.length ?? 0) > 0));
}

export function assertBeforeFactory(estimate: any) {
  if (!['Active', 'Ordered', 'Pending order review'].includes(estimate?.status?.name))
    throw new BadRequestException('This estimate is not available for a material revision.');
  if (!isBeforeFactory(estimate))
    throw new ConflictException('Materials already sent to the manufacturer cannot be changed here. A separate factory amendment is required.');
}

export function ownerCanAddBeforeRemeasurement(estimate: any, actorId: number): boolean {
  const job = estimate?.installationJob;
  if (!job || estimate.order || estimate.idUser !== actorId ||
      !['client', 'dealer'].includes(estimate.user?.role?.name) ||
      !['MEASUREMENT_SCHEDULING', 'MEASUREMENT_SCHEDULED', 'MEASUREMENT_PENDING'].includes(job.status) ||
      job.dealerMeasurementsAcceptedAt ||
      (job.measurements ?? []).some((measurement: any) => measurement.status === 'COMPLETED' || measurement.measuredAt)) return false;
  const deposits = (estimate.payments ?? []).filter((payment: any) =>
    payment.type === 'INSTALLATION_DEPOSIT' && payment.installationJobId === job.id);
  return !deposits.some((payment: any) => payment.refundReviewPending) &&
    deposits.some((payment: any) => paymentIsCovered(payment) && paidPrincipal(payment).gt(0));
}

export function assertNoOpenMaterialCheckout(estimate: any) {
  if ((estimate.payments ?? []).some((payment: any) => payment.status === 'PENDING' && payment.stripeSessionId))
    throw new ConflictException('Cancel the open checkout before preparing or approving a material revision.');
  if ((estimate.payments ?? []).some((payment: any) => payment.refundReviewPending))
    throw new ConflictException('Complete the pending refund review before changing the material agreement.');
}

export async function assertNoPendingMaterialRevision(db: Prisma.TransactionClient, estimateId: number) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    select: { materialRevisions: { where: { activeSlot: 1 }, select: { id: true }, take: 1 } },
  });
  if (estimate?.materialRevisions?.length) throw new ConflictException(MATERIAL_REVISION_PENDING_MESSAGE);
}

export async function assertMaterialReadyForFactory(db: Prisma.TransactionClient, estimateId: number) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    select: {
      materialRevisions: { select: { activeSlot: true, status: true } },
      installationJob: { select: { status: true, measurements: { where: { status: 'PENDING', isManual: false, pieceId: { not: null } }, select: { id: true }, take: 1 } } },
    },
  });
  if (estimate?.materialRevisions?.some(revision => revision.activeSlot === 1))
    throw new ConflictException(MATERIAL_REVISION_PENDING_MESSAGE);
  if (estimate?.materialRevisions?.some(revision => revision.status === 'APPLIED') &&
      estimate.installationJob?.status !== 'CANCELED' && estimate.installationJob?.measurements?.length)
    throw new ConflictException('The added or revised units still require field measurement before the order can be sent to the manufacturer.');
}

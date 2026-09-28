import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { paymentPreviewAfterSigning } from './change-order-payment-preview';
import { buildPaymentSchedule, scheduleInclude } from '@/payment-plans/payment-schedule';
import { projectMaterialRevision } from '@/estimates/material-revisions/material-revision-snapshot';

// Solo importes del cliente. Nunca devuelve costos, márgenes, plan del dealer ni
// piezas de la propuesta a través de la vista de precio total.
export async function materialChangePreview(
  db: Prisma.TransactionClient,
  estimateId: number,
  revisionId: number,
  paymentsEnabled: boolean,
) {
  const revision = await db.materialRevision.findFirst({
    where: { id: revisionId, estimateId },
    select: { originalSummary: true, revisedSummary: true, proposal: true, status: true, activeSlot: true },
  });
  if (!revision?.proposal || !revision.revisedSummary) return null;
  const before = revision.originalSummary as any;
  const after = revision.revisedSummary as any;
  const previousTotal = new Decimal(String(before.customerProjectTotal)).toFixed(2);
  const newTotal = new Decimal(String(after.customerProjectTotal)).toFixed(2);
  let paymentPreview: { dueAfterSigning: string; remainingScheduled: string; balance: string; paid: string } | null = null;
  if (paymentsEnabled && revision.status === 'AWAITING_SIGNATURE' && revision.activeSlot === 1) {
    const estimate = await db.estimate.findUnique({ where: { id: estimateId }, include: scheduleInclude });
    if (estimate) {
      // Simula únicamente lo que ocurrirá al aplicar esta firma. No persiste ni
      // habilita checkout mientras la revisión real continúe pendiente.
      const projected = { ...projectMaterialRevision(estimate, revision), materialRevisions: [] };
      const schedule = buildPaymentSchedule(projected);
      if (schedule) {
        paymentPreview = paymentPreviewAfterSigning(schedule);
      }
    }
  }
  return {
    previousTotal, newTotal, difference: new Decimal(newTotal).minus(previousTotal).toFixed(2),
    incomplete: Boolean(after.customerTotalIncomplete),
    paymentPreview,
  };
}

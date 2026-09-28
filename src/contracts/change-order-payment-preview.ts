import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { buildPaymentSchedule, scheduleInclude } from '@/payment-plans/payment-schedule';

export function paymentPreviewAfterSigning(schedule: NonNullable<ReturnType<typeof buildPaymentSchedule>>) {
  const due = schedule.rows
    .filter(row => row.status === 'DUE' || row.sequence === schedule.next?.sequence)
    .reduce((sum, row) => sum.plus(row.balance), new Decimal(0));
  return {
    dueAfterSigning: due.toFixed(2),
    remainingScheduled: Decimal.max(0, new Decimal(schedule.balance).minus(due)).toFixed(2),
    balance: schedule.balance,
    paid: schedule.paid,
  };
}

export async function changeOrderPaymentPreview(
  db: Prisma.TransactionClient,
  estimateId: number,
  paymentsEnabled: boolean,
) {
  // Un cliente de dealer externo nunca recibe el cronograma interno del dealer.
  if (!paymentsEnabled) return null;
  const estimate = await db.estimate.findUnique({ where: { id: estimateId }, include: scheduleInclude });
  if (!estimate) return null;
  const job = estimate.installationJob;
  if (job && job.status !== 'CANCELED' && job.quotes?.[0]?.status !== 'APPROVED') return null;
  // Los escritores del presupuesto aprobado ya sincronizan las diferencias.
  // Esta consulta es de solo lectura y no altera los documentos firmados.
  const schedule = buildPaymentSchedule(estimate);
  return schedule && !schedule.materialRevisionPending ? paymentPreviewAfterSigning(schedule) : null;
}

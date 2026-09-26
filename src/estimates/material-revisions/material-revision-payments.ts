import { defaultPlan, planRows, type PlanSnapshot } from '@/payment-plans/payment-plan';
import { scheduleAmounts } from '@/payment-plans/payment-schedule';

// La única incorporación de un plan a una orden antigua ocurre al aprobar
// una revisión con diferencia. Refleja sus hitos originales: material pagado
// al ordenar e instalación antes del trabajo. No toca pagos ni recibos.
export function legacyMaterialRevisionPlan(estimate: any, at = new Date()): PlanSnapshot {
  const hasInstallation = Boolean(estimate.installationJob && estimate.installationJob.status !== 'CANCELED');
  const snapshot: PlanSnapshot = { version: 1, planId: null, name: 'Original payment terms', definition: defaultPlan };
  const amounts = scheduleAmounts(estimate);
  const rows = planRows(snapshot, amounts, hasInstallation);
  snapshot.locked = { amounts, rows, at: at.toISOString() };
  snapshot.legacyPaymentCredits = (estimate.payments ?? []).flatMap((payment: any) => {
    if (!['MATERIAL', 'INSTALLATION'].includes(payment.type) || !Number.isSafeInteger(payment.id)) return [];
    const row = rows.find(candidate => candidate.milestone === (payment.type === 'MATERIAL' ? 'ORDER' : 'INSTALL'));
    return row ? [{ paymentId: payment.id, type: payment.type, sequence: row.sequence }] : [];
  });
  return snapshot;
}

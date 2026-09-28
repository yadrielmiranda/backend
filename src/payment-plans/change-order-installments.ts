import Decimal from 'decimal.js';
import {
  milestones, money, planRows, PlanSnapshot, ScheduleAmounts, ScheduleRow,
} from './payment-plan';

// Se aplica el plan contratado SOLO a la diferencia. No se reescriben cuotas,
// recibos, anticipos ni porcentajes originales. Los impuestos ya van en material.
export function changeOrderInstallments(
  snapshot: PlanSnapshot,
  previous: ScheduleAmounts,
  current: ScheduleAmounts,
  withInstallation: boolean,
  firstSequence: number,
  changeNumber: number,
  options: { materialRevision?: boolean; materialRevisionId?: number } = {},
): Array<ScheduleRow & { amounts: ScheduleAmounts }> {
  const label = options.materialRevision ? 'Material change' : 'Change order adjustment';
  const metadata = {
    planAdjustment: true,
    ...(options.materialRevision ? { materialRevision: true,
      ...(options.materialRevisionId ? { materialRevisionId: options.materialRevisionId } : {}) } : {}),
  };
  const positive: ScheduleAmounts = { material: '0.00', installation: '0.00', permit: '0.00', city: '0.00' };
  const negative = { ...positive };
  for (const key of ['material', 'installation', 'permit'] as const) {
    const delta = new Decimal(current[key]).minus(previous[key]);
    positive[key] = money(Decimal.max(0, delta));
    negative[key] = money(Decimal.max(0, delta.negated()));
  }
  // Calcular aumentos y reducciones por separado conserva los centavos y los
  // porcentajes incluso si aumenta material y disminuye instalación, o viceversa.
  const increases = planRows(snapshot, positive, withInstallation);
  const decreases = planRows(snapshot, negative, withInstallation);
  const result: Array<ScheduleRow & { amounts: ScheduleAmounts }> = [];
  for (const milestone of milestones) {
    const added = increases.find(row => row.milestone === milestone);
    const removed = decreases.find(row => row.milestone === milestone);
    const amount = new Decimal(added?.amount ?? 0).minus(removed?.amount ?? 0);
    if (amount.eq(0)) continue;
    const term = added ?? removed!;
    result.push({
      sequence: firstSequence + result.length,
      milestone,
      ...metadata,
      title: `${label} #${changeNumber} · ${term.title}`,
      description: amount.lt(0)
        ? 'Approved project reduction. The credit is applied to the remaining balance.'
        : milestone === 'ORDER'
          ? 'Additional initial payment for the approved change. Previous payments remain credited.'
          : 'Remaining payment for the approved change, according to the agreed payment plan.',
      amount: money(amount),
      amounts: { ...current, city: previous.city },
    });
  }
  // Un cambio neto cero también debe guardar su nueva distribución como base.
  if (!result.length) result.push({
    sequence: firstSequence, milestone: 'ORDER', ...metadata,
    title: `${label} #${changeNumber} · No additional payment`,
    description: 'Approved change with no change to the project total.',
    amount: '0.00', amounts: { ...current, city: previous.city },
  });
  return result;
}

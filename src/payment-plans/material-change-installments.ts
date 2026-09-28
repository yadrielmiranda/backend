import { changeOrderInstallments } from './change-order-installments';
import type { PlanSnapshot, ScheduleAmounts, ScheduleRow } from './payment-plan';

// Conserva la identificación de las revisiones de material y sus controles de
// envío a fábrica. El cálculo por plan es el mismo para instalación y material.
export function materialChangeInstallments(
  snapshot: PlanSnapshot,
  previous: ScheduleAmounts,
  current: ScheduleAmounts,
  withInstallation: boolean,
  firstSequence: number,
  changeNumber: number,
  revisionId?: number,
): Array<ScheduleRow & { amounts: ScheduleAmounts }> {
  return changeOrderInstallments(
    snapshot, previous, current, withInstallation, firstSequence, changeNumber,
    { materialRevision: true, materialRevisionId: revisionId },
  );
}

import { Prisma } from '@prisma/client';
import { EarningsPlanSnapshot, loadActiveEarningsPlan } from './earnings-plan';

type EstimateEarningsState = {
  id: number;
  idUser: number;
  dealerModeSnapshot?: string | null;
  dealerEarningsPlanSnapshot?: Prisma.JsonValue | EarningsPlanSnapshot | null;
  status?: { name: string } | null;
  order?: unknown;
  payments?: readonly unknown[];
};

export function canRefreshDraftEarningsPlan(estimate: EstimateEarningsState) {
  const saved = estimate.dealerEarningsPlanSnapshot as Partial<EarningsPlanSnapshot> | null;
  return estimate.dealerModeSnapshot === 'INTERNAL' &&
    estimate.status?.name === 'Active' && estimate.order === null &&
    Array.isArray(estimate.payments) && estimate.payments.length === 0 &&
    saved?.version === 2 && saved.lockedAt == null &&
    Number.isSafeInteger(saved.planId) && saved.planId! > 0;
}

/** Actualiza solo borradores sin actividad de pago; los históricos sin plan conservan su 0%. */
export async function refreshDraftEarningsPlan(
  tx: Prisma.TransactionClient,
  estimate: EstimateEarningsState,
  options: { freeze?: boolean } = {},
) {
  if (!canRefreshDraftEarningsPlan(estimate)) return;

  // El mismo bloqueo serializa edición, checkout y registro manual del pago.
  const [locked] = await tx.$queryRaw<Array<{ dealerEarningsPlanSnapshot: Prisma.JsonValue }>>
    `SELECT id, dealerEarningsPlanSnapshot FROM Estimate WHERE id = ${estimate.id} FOR UPDATE`;
  if (!locked) return;
  // Lee también el sello actual si la transacción ya había consultado una copia anterior.
  estimate.dealerEarningsPlanSnapshot = locked.dealerEarningsPlanSnapshot;
  const current = await tx.estimate.findUnique({
    where: { id: estimate.id },
    select: {
      id: true, idUser: true, dealerModeSnapshot: true, dealerEarningsPlanSnapshot: true,
      status: { select: { name: true } }, order: { select: { id: true } },
      payments: { select: { id: true } },
    },
  });
  if (!current) return;
  current.dealerEarningsPlanSnapshot = locked.dealerEarningsPlanSnapshot;
  if (!canRefreshDraftEarningsPlan(current)) return;

  // Lecturas actuales: una transacción anterior no debe recuperar una asignación vieja.
  // Se mantiene el orden usuario -> plan que usan las asignaciones administrativas.
  const [owner] = await tx.$queryRaw<Array<{ dealerMode: string | null; dealerEarningsPlanId: number | null }>>
    `SELECT dealerMode, dealerEarningsPlanId FROM User WHERE id = ${current.idUser} LOCK IN SHARE MODE`;
  if (owner?.dealerMode !== 'INTERNAL' || owner.dealerEarningsPlanId == null) return;
  const plan = await loadActiveEarningsPlan(tx, owner.dealerEarningsPlanId, 'shared');
  const snapshot = options.freeze ? { ...plan, lockedAt: new Date().toISOString() } : plan;
  const saved = current.dealerEarningsPlanSnapshot as unknown as EarningsPlanSnapshot;
  if (!options.freeze && saved.planId === plan.planId && saved.revision === plan.revision &&
      saved.name === plan.name && saved.basis === plan.basis && saved.percent === plan.percent) return;

  await tx.estimate.update({
    where: { id: current.id },
    data: { dealerEarningsPlanSnapshot: snapshot },
  });
  estimate.dealerEarningsPlanSnapshot = snapshot;
}

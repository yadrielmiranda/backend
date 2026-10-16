import type { Prisma } from '@prisma/client';
import { planRows, planSnapshot, type PlanSnapshot, type ScheduleAmounts } from '@/payment-plans/payment-plan';
import { cents, distributeCents } from './payment-accounting';
import { freezeInstallationProcessingShare, restoreInstallationProcessingShare, type InstallationProcessingShare } from './installation-processing-cost';
export { buildInstallationProcessingShare, withInstallationProcessingShare } from './installation-processing-cost';

const keys = ['material', 'installation', 'permit', 'city', 'other'] as const;
type Component = typeof keys[number];
export type ProcessingComponents = Record<Component, string> & {
  allocationPending?: true;
  installationShare?: InstallationProcessingShare;
  installationSharePending?: true;
};
const empty = (): ProcessingComponents => ({ material: '0.00', installation: '0.00', permit: '0.00', city: '0.00', other: '0.00' });
const money = (value: number) => `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`;
const componentCents = (value: ProcessingComponents) => keys.map(key => cents(value[key]));
const fromCents = (values: number[]): ProcessingComponents => {
  const result = empty();
  keys.forEach((key, index) => { result[key] = money(values[index]); });
  return result;
};

export function singleProcessingComponent(component: Component, amount: { toString(): string } | string): ProcessingComponents {
  return { ...empty(), [component]: money(cents(amount)) };
}

export function pendingProcessingComponents(amount: { toString(): string } | string): ProcessingComponents {
  return { ...singleProcessingComponent('other', amount), allocationPending: true };
}

export function refundedProcessingComponents(saved: unknown, amount: { toString(): string } | string): ProcessingComponents {
  try {
    const snapshot = saved as { version?: number; allocationPending?: boolean; components?: ProcessingComponents; total?: string; materialSurcharge?: string; installationShare?: unknown; installationSharePending?: boolean } | null;
    if (snapshot?.version !== 1 || snapshot.allocationPending || !snapshot.components ||
        keys.some(key => typeof snapshot.components![key] !== 'string') ||
        typeof snapshot.total !== 'string' || typeof snapshot.materialSurcharge !== 'string') return pendingProcessingComponents(amount);
    const weights = componentCents(snapshot.components);
    if (weights.reduce((sum, value) => sum + value, 0) !== cents(snapshot.total) || cents(snapshot.materialSurcharge) > weights[0])
      return pendingProcessingComponents(amount);
    // El saldo nuevo se imputa con las proporciones del cobro original. Los
    // componentes resultantes son BASE; el builder añade solamente su recargo nuevo.
    const result = fromCents(distributeCents(cents(amount), weights));
    if (snapshot.installationSharePending) result.installationSharePending = true;
    else if (snapshot.installationShare && cents(result.installation) > 0) {
      try { result.installationShare = restoreInstallationProcessingShare(snapshot.installationShare, result.installation); }
      catch { result.installationSharePending = true; }
    }
    return result;
  } catch {
    return pendingProcessingComponents(amount);
  }
}

// Cuotas PROJECT: el importe ya calculado manda. Se distribuyen sus centavos
// proporcionalmente sobre los componentes restantes, sin recalcular el cobro.
function componentRows(snapshot: PlanSnapshot, amounts: ScheduleAmounts, withInstallation: boolean) {
  const rows = planRows(snapshot, amounts, withInstallation);
  const steps = snapshot.definition[withInstallation ? 'withInstallation' : 'withoutInstallation'];
  if (steps.some(step => step.basis === 'PROJECT')) {
    if (steps.some(step => step.basis !== 'PROJECT')) throw new Error('Mixed project bases');
    let remaining = componentCents({ ...empty(), ...amounts });
    return rows.map(row => {
      const allocated = distributeCents(cents(row.amount), remaining);
      remaining = remaining.map((value, index) => value - allocated[index]);
      return { ...row, components: fromCents(allocated) };
    });
  }
  // MATERIAL / INSTALLATION conservan su redondeo independiente y los permisos
  // y City Fee que planRows incorpora en la primera cuota.
  const isolated = keys.slice(0, 4).map(key => {
    const base = { material: '0.00', installation: '0.00', permit: '0.00', city: '0.00', [key]: amounts[key as keyof ScheduleAmounts] };
    return planRows(snapshot, base, withInstallation);
  });
  return rows.map(row => {
    const allocated = isolated.map(group => cents(group.find(item => item.milestone === row.milestone)?.amount ?? '0'));
    allocated.push(0);
    if (allocated.reduce((sum, value) => sum + value, 0) !== cents(row.amount)) throw new Error('Component total mismatch');
    return { ...row, components: fromCents(allocated) };
  });
}

/** Deposits are advance credits against the earliest plan rows, regardless of
 * their legacy payment type. Use the complement of the remaining row so the
 * deposit and the later installment conserve the same component cents. */
export function advanceProcessingComponents(params: {
  snapshot: unknown;
  amounts: ScheduleAmounts;
  withInstallation: boolean;
  amount: { toString(): string } | string;
}): ProcessingComponents {
  try {
    const snapshot = planSnapshot(params.snapshot);
    if (!snapshot) return pendingProcessingComponents(params.amount);
    const amounts = snapshot.locked?.amounts ?? params.amounts;
    const rows = componentRows(snapshot, amounts, params.withInstallation || cents(amounts.installation) > 0);
    if (snapshot.locked && (rows.length !== snapshot.locked.rows.length || rows.some((row, index) => {
      const saved = snapshot.locked!.rows[index];
      return row.sequence !== saved.sequence || row.milestone !== saved.milestone || cents(row.amount) !== cents(saved.amount);
    }))) return pendingProcessingComponents(params.amount);
    let remaining = cents(params.amount);
    const allocated = keys.map(() => 0);
    for (const row of rows) {
      if (!remaining) break;
      const used = Math.min(remaining, cents(row.amount));
      const original = componentCents(row.components);
      const balance = distributeCents(cents(row.amount) - used, original);
      original.forEach((value, index) => { allocated[index] += value - balance[index]; });
      remaining -= used;
    }
    return remaining ? pendingProcessingComponents(params.amount) : fromCents(allocated);
  } catch { return pendingProcessingComponents(params.amount); }
}

const sameAmounts = (a: ScheduleAmounts, b: ScheduleAmounts) =>
  keys.slice(0, 4).every(key => a[key as keyof ScheduleAmounts] === b[key as keyof ScheduleAmounts]);

export function installmentProcessingComponents(params: {
  snapshot: unknown;
  amounts: ScheduleAmounts;
  withInstallation: boolean;
  // Frozen customer charges collected with materials in a material-only plan.
  // They remain unrelated services for profit and processing-cost allocation.
  customMaterialAmount?: string;
  row: { sequence: number; milestone: string; amount: string; balance: string; originalAmount?: string; kind?: string };
}): ProcessingComponents {
  const { row } = params;
  const balance = cents(row.balance);
  if (!balance) return empty();
  try {
    const snapshot = planSnapshot(params.snapshot);
    if (!snapshot) return pendingProcessingComponents(row.balance);
    let components: ProcessingComponents;
    const adjustment = snapshot.adjustments?.find(item => item.sequence === row.sequence);
    if (adjustment) {
      if (adjustment.kind === 'CITY_FEE') return singleProcessingComponent('city', row.balance);
      if (!snapshot.locked || !adjustment.planAdjustment) return pendingProcessingComponents(row.balance);
      if (cents(params.customMaterialAmount ?? '0') > 0 && cents(snapshot.locked.amounts.installation) > 0)
        return pendingProcessingComponents(row.balance);
      const adjustments = snapshot.adjustments!;
      let first = adjustments.indexOf(adjustment);
      // amounts es el total acumulado de la revisión, compartido por sus filas.
      while (first > 0 && adjustments[first - 1].planAdjustment && sameAmounts(adjustments[first - 1].amounts, adjustment.amounts)) first--;
      const previous = first ? adjustments[first - 1].amounts : snapshot.locked.amounts;
      if (cents(previous.city) !== cents(adjustment.amounts.city)) return pendingProcessingComponents(row.balance);
      const positive: ScheduleAmounts = { material: '0.00', installation: '0.00', permit: '0.00', city: '0.00' };
      const negative = { ...positive };
      for (const key of ['material', 'installation', 'permit'] as const) {
        const delta = cents(adjustment.amounts[key]) - cents(previous[key]);
        positive[key] = money(Math.max(0, delta));
        negative[key] = money(Math.max(0, -delta));
      }
      const withInstallation = params.withInstallation || cents(previous.installation) > 0;
      const added = componentRows(snapshot, positive, withInstallation).find(item => item.milestone === row.milestone);
      const removed = componentRows(snapshot, negative, withInstallation).find(item => item.milestone === row.milestone);
      const net = componentCents(added?.components ?? empty()).map((value, index) => value - componentCents(removed?.components ?? empty())[index]);
      if (net.some(value => value < 0) || net.reduce((sum, value) => sum + value, 0) !== cents(adjustment.amount)) return pendingProcessingComponents(row.balance);
      components = fromCents(net);
    } else {
      const amounts = snapshot.locked?.amounts ?? params.amounts;
      const withInstallation = params.withInstallation || cents(amounts.installation) > 0;
      const rows = componentRows(snapshot, amounts, withInstallation);
      const customMaterial = withInstallation ? 0 : cents(params.customMaterialAmount ?? '0');
      if (customMaterial > 0) {
        const materialAmounts = rows.map(item => cents(item.components.material));
        if (customMaterial > materialAmounts.reduce((sum, amount) => sum + amount, 0))
          return pendingProcessingComponents(row.balance);
        const customByRow = distributeCents(customMaterial, materialAmounts);
        rows.forEach((item, index) => {
          item.components = { ...item.components,
            material: money(materialAmounts[index] - customByRow[index]),
            other: money(cents(item.components.other) + customByRow[index]),
          };
        });
      }
      const expected = rows.find(item => item.sequence === row.sequence && item.milestone === row.milestone);
      const saved = snapshot.locked?.rows.find(item => item.sequence === row.sequence);
      if (!expected || (snapshot.locked && (!saved || saved.milestone !== expected.milestone || cents(saved.amount) !== cents(expected.amount))))
        return pendingProcessingComponents(row.balance);
      if (cents(row.originalAmount ?? row.amount) !== cents(expected.amount)) return pendingProcessingComponents(row.balance);
      components = expected.components;
    }
    // Regla de imputación: créditos/reembolsos reducen proporcionalmente el saldo
    // de la composición fiable original; no alteran sus importes comerciales.
    return fromCents(distributeCents(balance, componentCents(components)));
  } catch {
    // Un histórico ambiguo no bloquea el cobro ni inventa una asignación material.
    return pendingProcessingComponents(row.balance);
  }
}

/** Congela exclusivamente el contexto monetario del checkout, nunca el estimate mutable. */
export function freezeProcessingCostSnapshot(context: {
  baseAmount: { toString(): string } | string;
  surchargeAmount: { toString(): string } | string;
  totalAmount: { toString(): string } | string;
  processingComponents?: ProcessingComponents;
}): Prisma.InputJsonValue {
  const base = cents(context.baseAmount), surcharge = cents(context.surchargeAmount), total = cents(context.totalAmount);
  const pending = () => ({ version: 1, components: singleProcessingComponent('other', money(total)),
    total: money(total), materialSurcharge: '0.00', allocationPending: true });
  try {
    const components = context.processingComponents;
    if (!components || components.allocationPending || base + surcharge !== total) return pending();
    const amounts = componentCents(components);
    if (amounts.reduce((sum, value) => sum + value, 0) !== base) return pending();
    const fees = distributeCents(surcharge, amounts);
    let installation: Record<string, any> = {};
    if (amounts[1] > 0) {
      if (components.installationSharePending) installation = { installationSharePending: true };
      else if (components.installationShare) {
        try { installation = { installationShare: freezeInstallationProcessingShare(components.installationShare, amounts[1], fees[1]) }; }
        catch { installation = { installationSharePending: true }; }
      }
    }
    return { version: 1, components: fromCents(amounts.map((amount, index) => amount + fees[index])),
      total: money(total), materialSurcharge: money(fees[0]), ...installation };
  } catch {
    return pending();
  }
}

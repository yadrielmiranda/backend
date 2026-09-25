import { BadRequestException } from '@nestjs/common';
import { DealerEarningsBasis, Prisma, type DealerEarningsPlan } from '@prisma/client';
import Decimal from 'decimal.js';

export type EarningsPlanSnapshot = {
  version: 2;
  planId: number | null;
  name: string;
  revision: number | null;
  basis: DealerEarningsBasis;
  percent: string;
  lockedAt?: string;
};

export function validateEarningsRule(basis: unknown, percent: unknown) {
  if (!Object.values(DealerEarningsBasis).includes(basis as DealerEarningsBasis))
    throw new BadRequestException('Select a valid earnings basis.');
  const value = String(percent ?? '').trim();
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(value) || new Decimal(value).gt(100))
    throw new BadRequestException('Earnings percentage must be between 0 and 100 with up to 4 decimal places.');
  return { basis: basis as DealerEarningsBasis, percent: new Decimal(value).toString() };
}

export function earningsPlanSnapshot(plan: {
  id: number; name: string; revision: number;
  basis: DealerEarningsBasis; percent: { toString(): string };
}): EarningsPlanSnapshot & { planId: number; revision: number } {
  return {
    version: 2, planId: plan.id, name: plan.name, revision: plan.revision,
    ...validateEarningsRule(plan.basis, plan.percent),
  };
}

export async function loadActiveEarningsPlan(
  db: Prisma.TransactionClient,
  id?: number | null,
  lock: 'exclusive' | 'shared' = 'exclusive',
) {
  if (id == null || !Number.isSafeInteger(id) || id <= 0)
    throw new BadRequestException('Assign an earnings plan to this internal dealer.');
  // Asignar, crear estimados, editar y eliminar un plan comparten este bloqueo.
  // La lectura bloqueada devuelve también las condiciones actuales. Una lectura
  // normal posterior podría ver una versión anterior bajo REPEATABLE READ.
  const locking = lock === 'shared' ? Prisma.sql`LOCK IN SHARE MODE` : Prisma.sql`FOR UPDATE`;
  const [plan] = await db.$queryRaw<Array<Pick<DealerEarningsPlan, 'id' | 'name' | 'basis' | 'percent' | 'revision' | 'isActive'>>>
    `SELECT id, name, basis, percent, revision, isActive FROM DealerEarningsPlan WHERE id = ${id} ${locking}`;
  if (!plan?.isActive) throw new BadRequestException('The selected earnings plan is unavailable.');
  return earningsPlanSnapshot(plan);
}

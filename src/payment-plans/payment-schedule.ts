import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import {
  allocateSchedule,
  defaultPlan,
  Milestone,
  money,
  PlanSnapshot,
  planRows,
  planSnapshot,
  ScheduleAmounts,
  sumAmounts,
  validatePlan,
} from './payment-plan';

export const scheduleInclude = {
  status: true,
  payments: true,
  order: { include: { status: true } },
  installationJob: {
    include: {
      permit: true,
      appointments: {
        where: { type: 'INSTALLATION', status: 'ACCEPTED' },
        take: 1,
      },
      quotes: { orderBy: { version: 'desc' as const }, take: 1 },
    },
  },
} satisfies Prisma.EstimateInclude;

export async function resolveNewPlan(
  db: Prisma.TransactionClient,
  userId: number,
): Promise<PlanSnapshot> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    include: { role: true },
  });
  const id = user.paymentPlanId ?? user.role.paymentPlanId;
  const plan = id ? await db.paymentPlan.findUnique({ where: { id } }) : null;
  return {
    version: 1,
    planId: plan?.id ?? null,
    name: plan?.name ?? 'Material upfront / installation before work',
    definition: plan ? validatePlan(plan.definition) : defaultPlan,
  };
}

export function scheduleAmounts(estimate: any): ScheduleAmounts {
  const job =
    estimate.installationJob?.status === 'CANCELED'
      ? null
      : estimate.installationJob;
  const discount = calculateEstimateDiscount(estimate, job);
  return {
    material: money(
      discount?.material.total ??
        String(
          estimate.dealerModeSnapshot === 'INTERNAL'
            ? estimate.customerTotalPayable
            : estimate.totalPayable,
        ),
    ),
    installation: money(
      discount?.installation.total ?? String(job?.quotes?.[0]?.total ?? 0),
    ),
    permit: money(
      discount?.permit.total ?? String(job?.permit?.permitFeeSnapshot ?? 0),
    ),
    city: money(discount?.city.total ?? String(job?.permit?.cityFee ?? 0)),
  };
}

export function buildPaymentSchedule(estimate: any) {
  const snapshot = planSnapshot(estimate?.paymentPlanSnapshot);
  if (!snapshot) return null;
  const job =
    estimate.installationJob?.status === 'CANCELED'
      ? null
      : estimate.installationJob;
  const quote = job?.quotes?.[0];
  const amounts = scheduleAmounts(estimate);
  const rows = [
    ...(snapshot.locked?.rows ?? planRows(snapshot, amounts, Boolean(job))),
    ...(snapshot.adjustments ?? []),
  ];
  const orderStatus = estimate.order?.status?.name;
  const available: Milestone[] = [];
  if (
    !estimate.order &&
    estimate.status?.name === 'Active' &&
    estimate.units > 0 &&
    (!job ||
      (quote?.status === 'APPROVED' &&
        job.status === 'MATERIAL_PAYMENT_PENDING' &&
        (!job.permit ||
          (job.permit.status === 'APPROVED' && job.permit.cityFee != null))))
  )
    available.push('ORDER');
  if (estimate.order) {
    available.push('ORDER');
    if (
      [
        'Ready to pick up',
        'Picked up',
        'Delivered',
        'Installation in progress',
        'Installed',
      ].includes(orderStatus)
    )
      available.push('RELEASE');
    if (job && quote?.status === 'APPROVED' && available.includes('RELEASE'))
      available.push('INSTALL');
    if (
      job?.completedAt ||
      job?.status === 'COMPLETED' ||
      orderStatus === 'Installed'
    )
      available.push('COMPLETE');
  }
  const allocation = allocateSchedule(
    rows,
    estimate.payments ?? [],
    available,
    Boolean(estimate.order),
  );
  const installationPending = Boolean(job && quote?.status !== 'APPROVED');
  const cityFeePending = Boolean(job?.permit && job.permit.cityFee == null);
  const provisional = !snapshot.locked && (installationPending || cityFeePending);
  const provisionalMessage = !provisional
    ? null
    : installationPending && cityFeePending
      ? 'Amounts are preliminary until the installation quote and City Fee are finalized.'
      : installationPending
        ? 'Amounts are preliminary until the installation quote is finalized.'
        : 'Amounts are preliminary until the City Fee is finalized.';
  return {
    ...allocation,
    name: snapshot.name,
    provisional,
    provisionalMessage,
    canRelease:
      Boolean(estimate.order) &&
      allocation.rows.every(
        (row) =>
          !['ORDER', 'RELEASE'].includes(row.milestone) ||
          Number(row.balance) === 0,
      ),
    canInstall:
      Boolean(estimate.order) &&
      allocation.rows.every(
        (row) => row.milestone === 'COMPLETE' || Number(row.balance) === 0,
      ),
    initialSequence: rows[0]?.sequence ?? 1,
  };
}

export async function getPaymentSchedule(
  db: Prisma.TransactionClient,
  estimateId: number,
) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    include: scheduleInclude,
  });
  return estimate ? buildPaymentSchedule(estimate) : null;
}

export async function installmentContext(
  db: Prisma.TransactionClient,
  estimateId: number,
  sequence?: number,
  preview = false,
) {
  const estimate = await db.estimate.findUniqueOrThrow({
    where: { id: estimateId },
    include: scheduleInclude,
  });
  const snapshot = planSnapshot(estimate.paymentPlanSnapshot);
  if (!snapshot)
    throw new BadRequestException(
      'This estimate uses its original payment terms.',
    );
  const schedule = buildPaymentSchedule(estimate)!;
  const row =
    sequence == null
      ? schedule.next
      : schedule.rows.find((row) => row.sequence === sequence);
  if (!row || row.sequence !== schedule.next?.sequence)
    throw new ConflictException(
      'This installment is not the next payment due. Refresh the payment schedule.',
    );
  if (!preview && !snapshot.locked) {
    snapshot.locked = {
      amounts: scheduleAmounts(estimate),
      rows: planRows(
        snapshot,
        scheduleAmounts(estimate),
        Boolean(
          estimate.installationJob &&
            estimate.installationJob.status !== 'CANCELED',
        ),
      ),
      at: new Date().toISOString(),
    };
    await db.estimate.update({
      where: { id: estimateId },
      data: {
        paymentPlanSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return { row, schedule };
}

// Las modificaciones aprobadas son cargos separados; las cuotas originales y sus pagos no se reescriben.
export async function synchronizeScheduleChanges(
  db: Prisma.TransactionClient,
  estimateId: number,
) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    include: scheduleInclude,
  });
  const snapshot = planSnapshot(estimate?.paymentPlanSnapshot);
  if (!estimate || !snapshot?.locked) return;
  const job =
    estimate.installationJob?.status === 'CANCELED'
      ? null
      : estimate.installationJob;
  if (job && job.quotes[0]?.status !== 'APPROVED') return;
  const current = scheduleAmounts(estimate);
  const previous =
    snapshot.adjustments?.at(-1)?.amounts ?? snapshot.locked.amounts;
  if (
    Object.keys(current).every(
      (key) =>
        current[key as keyof ScheduleAmounts] ===
        previous[key as keyof ScheduleAmounts],
    )
  )
    return;
  if (
    estimate.payments.some((p) => p.status === 'PENDING' && p.stripeSessionId)
  )
    throw new ConflictException(
      'Cancel the open checkout before changing the payment schedule.',
    );
  if (
    !estimate.order &&
    !estimate.payments.some(
      (p) => p.type === 'INSTALLMENT' && p.status === 'PAID',
    )
  ) {
    // Un intento cancelado no fija una cotización aún editable. Se recalculan
    // sus porcentajes antes de confirmar la orden, conservando el mismo plan.
    delete snapshot.locked;
    delete snapshot.adjustments;
    await db.estimate.update({
      where: { id: estimateId },
      data: {
        paymentPlanSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    return;
  }
  const delta = sumAmounts(current).minus(sumAmounts(previous));
  const sequence = 101 + (snapshot.adjustments?.length ?? 0);
  const orderStatus = estimate.order?.status.name;
  const milestone: Milestone = !estimate.order
    ? 'ORDER'
    : orderStatus === 'Installed'
      ? 'COMPLETE'
      : ['Delivered', 'Picked up', 'Installation in progress'].includes(
            orderStatus ?? '',
          )
        ? 'INSTALL'
        : 'RELEASE';
  snapshot.adjustments = [
    ...(snapshot.adjustments ?? []),
    {
      sequence,
      milestone,
      title: `Change order adjustment #${sequence - 100}`,
      description:
        'Approved change to the project. Previous payments remain credited.',
      amount: money(delta),
      amounts: current,
    },
  ];
  await db.estimate.update({
    where: { id: estimateId },
    data: { paymentPlanSnapshot: snapshot as unknown as Prisma.InputJsonValue },
  });
}

export async function assertScheduleMilestone(
  db: Prisma.TransactionClient,
  estimateId: number,
  milestone: 'RELEASE' | 'INSTALL',
) {
  const schedule = await getPaymentSchedule(db, estimateId);
  if (
    schedule &&
    !(milestone === 'RELEASE' ? schedule.canRelease : schedule.canInstall)
  )
    throw new BadRequestException(
      milestone === 'RELEASE'
        ? 'Pay the installments required for material release before pickup or delivery.'
        : 'Pay the installments required before installation.',
    );
  return schedule;
}

// Los estados operativos avanzan con las cuotas previas al trabajo; la cuota final no bloquea la instalación.
export async function refreshScheduledInstallation(
  db: Prisma.TransactionClient,
  estimateId: number,
) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    include: scheduleInclude,
  });
  const schedule = estimate ? buildPaymentSchedule(estimate) : null;
  const job = estimate?.installationJob;
  if (
    !schedule ||
    !job ||
    !estimate?.order ||
    job.status === 'CANCELED' ||
    job.quotes[0]?.status !== 'APPROVED'
  )
    return false;
  const mutable = [
    'MATERIAL_PAYMENT_PENDING',
    'MATERIAL_PAID',
    'INSTALLATION_PAYMENT_PENDING',
    'INSTALLATION_PAID',
  ];
  if (!mutable.includes(job.status)) return false;
  const ready = [
    'Ready to pick up',
    'Delivered',
    'Picked up',
    'Installation in progress',
    'Installed',
  ].includes(estimate.order.status.name);
  const next =
    estimate.order.status.name === 'Installed' || job.completedAt
      ? 'COMPLETED'
      : estimate.order.status.name === 'Installation in progress'
        ? 'IN_PROGRESS'
        : ready
          ? schedule.canInstall
            ? job.appointments.length
              ? 'SCHEDULED'
              : 'INSTALLATION_PAID'
            : 'INSTALLATION_PAYMENT_PENDING'
          : 'MATERIAL_PAID';
  if (next === job.status) return false;
  await db.installationJob.update({
    where: { id: job.id },
    data: { status: next },
  });
  return true;
}

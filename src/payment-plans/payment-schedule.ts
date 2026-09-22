import { hasRefundHistory, paymentIsCovered } from '@/payments/payment-accounting';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { calculateEstimateDiscount } from '@/estimates/discounts/estimate-discount';
import {
  allocateSchedule,
  defaultPlan,
  Milestone,
  money,
  PlanSnapshot,
  PENDING_ORDER_REVIEW,
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
  const installments = snapshot.locked?.rows ?? planRows(snapshot, amounts, Boolean(job));
  const rows = [...installments, ...(snapshot.adjustments ?? [])];
  // La instalación depende del hito del plan, no de los ajustes pendientes.
  // Los planes cobrados por completo al ordenar no necesitan una cuota nueva.
  const installationMilestone = installments.some(row => row.milestone === 'INSTALL')
    ? 'INSTALL'
    : installments.some(row => row.milestone === 'RELEASE') ? 'RELEASE' : 'ORDER';
  const installationSequences = new Set(
    installments.filter(row => row.milestone === installationMilestone).map(row => row.sequence),
  );
  if (job && !estimate.order && rows[0]) rows[0] = { ...rows[0], description: 'Payment submits the estimate for administrative order review. An administrator creates the order after reviewing the project.' };
  const orderStatus = estimate.order?.status?.name;
  const available: Milestone[] = [];
  if (
    !estimate.order &&
    ['Active', PENDING_ORDER_REVIEW].includes(estimate.status?.name) &&
    estimate.units > 0 &&
    (!job ||
      (quote?.status === 'APPROVED' &&
        ['MATERIAL_PAYMENT_PENDING', 'PERMIT_PAYMENT_PENDING', 'PERMIT_PROCESSING'].includes(job.status)))
  )
    available.push('ORDER');
  if (estimate.order) {
    available.push('ORDER');
    if (
      [
        'Awaiting release',
        'Preparing for pickup',
        'Ready to pick up',
        'Picked up',
        'Delivered',
        'Installation in progress',
        'Installed',
      ].includes(orderStatus)
    )
      available.push('RELEASE');
    if (
      job &&
      quote?.status === 'APPROVED' &&
      [
        'Preparing for pickup',
        'Ready to pick up',
        'Picked up',
        'Delivered',
        'Installation in progress',
        'Installed',
      ].includes(orderStatus)
    )
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
  // La cuota inicial puede volver a tener saldo después de una devolución.
  // Solo cambia su presentación; la orden y los importes permanecen intactos.
  const initialInstallment = allocation.rows.find(
    row => row.sequence === installments[0]?.sequence,
  );
  if (
    estimate.order &&
    initialInstallment?.milestone === 'ORDER' &&
    Number(initialInstallment.balance) > 0
  ) {
    initialInstallment.title = 'Outstanding balance · First installment';
    initialInstallment.description =
      'Remaining balance of the first installment for your existing order.';
  }
  const installationPending = Boolean(job && quote?.status !== 'APPROVED');
  const cityFeePending = Boolean(job?.permit && job.permit.cityFee == null);
  const provisional = cityFeePending || (!snapshot.locked && installationPending);
  const orderReviewPending = !estimate.order && estimate.status?.name === PENDING_ORDER_REVIEW;
  // Las fechas de exigibilidad no impiden adelantar voluntariamente el saldo aprobado.
  const fullBalanceRows = allocation.rows.filter(row =>
    Number(row.balance) > 0 || row.status === 'DUE' || row.sequence === allocation.next?.sequence,
  );
  const fullBalanceAmount = fullBalanceRows.reduce((total, row) => total.add(row.balance), new Prisma.Decimal(0));
  const fullBalance = fullBalanceAmount.gt(0) && !installationPending && !allocation.refundReviewPending &&
    estimate.units > 0 && (Boolean(estimate.order) || available.includes('ORDER') || orderReviewPending) &&
    ['Active', PENDING_ORDER_REVIEW, 'Ordered'].includes(estimate.status?.name) &&
    !['Canceled', 'Cancelled'].includes(orderStatus)
    ? { amount: fullBalanceAmount.toFixed(2), sequences: fullBalanceRows.map(row => row.sequence) }
    : null;
  const orderReviewBlockedReason = !orderReviewPending ? null
    : estimate.units <= 0 ? 'At least one material unit is required to create an order.'
    : installationPending ? 'The installation quote must be approved before the order can be created.'
    : allocation.rows.some(row => row.milestone === 'ORDER' && row.kind !== 'CITY_FEE' && (Number(row.balance) > 0 || row.status === 'REVIEW'))
      ? 'Pay the outstanding order installment or approved project adjustment before creating the order.'
      : null;
  const provisionalMessage = !provisional
    ? null
    : installationPending && cityFeePending
      ? 'Amounts are preliminary until the installation quote and City Fee are finalized.'
      : installationPending
        ? 'Amounts are preliminary until the installation quote is finalized.'
        : snapshot.locked
          ? 'Project total excludes the pending City Fee. It will be added as a separate adjustment; original installments remain unchanged.'
          : 'Amounts are preliminary until the City Fee is finalized.';
  return {
    ...allocation,
    name: snapshot.name,
    requiresOrderReview: Boolean(job && !estimate.order),
    orderReviewPending,
    orderReviewBlockedReason,
    fullBalance,
    cityFeePending,
    provisional,
    provisionalMessage,
    canRelease:
      Boolean(estimate.order) &&
      allocation.rows.every(
        (row) =>
          // El City Fee independiente sigue adeudado, pero no condiciona la entrega.
          row.kind === 'CITY_FEE' ||
          !['ORDER', 'RELEASE'].includes(row.milestone) ||
          (row.status !== 'REVIEW' && Number(row.balance) === 0),
      ),
    canInstall:
      Boolean(estimate.order) &&
      installationSequences.size > 0 &&
      allocation.rows.every(
        (row) => !installationSequences.has(row.sequence) || (Number(row.balance) === 0 && row.status !== 'REVIEW'),
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
  allowAdvance = false,
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
  const advanceAvailable = allowAdvance && schedule.fullBalance?.sequences.includes(row?.sequence ?? -1);
  if (!row || row.status === 'REVIEW' || (!advanceAvailable && row.status !== 'DUE' && row.sequence !== schedule.next?.sequence))
    throw new ConflictException(
      'This installment is not available for payment. Refresh the payment schedule.',
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
      (p) => p.type === 'INSTALLMENT' && (p.status === 'PAID' || p.netPaidBaseAmount != null),
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
  // El City Fee conocido después del primer pago no redistribuye las cuotas.
  // Se registra por separado incluso si también cambió otro importe del proyecto.
  const cityDelta = new Prisma.Decimal(current.city).minus(previous.city);
  const withoutCityChange = { ...current, city: previous.city };
  const delta = sumAmounts(withoutCityChange).minus(sumAmounts(previous));
  const adjustments = [...(snapshot.adjustments ?? [])];
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
  if (!delta.eq(0) || cityDelta.eq(0)) {
    const sequence = 101 + adjustments.length;
    adjustments.push({
      sequence, milestone,
      title: `Change order adjustment #${sequence - 100}`,
      description: 'Approved change to the project. Previous payments remain credited.',
      amount: money(delta), amounts: withoutCityChange,
    });
  }
  if (!cityDelta.eq(0)) {
    adjustments.push({
      sequence: 101 + adjustments.length,
      kind: 'CITY_FEE', milestone: 'ORDER', title: 'City Fee adjustment',
      description: cityDelta.lt(0) ? 'City Fee reduced. The difference is credited to the project balance.' : 'City Fee added after the first installment. Review and accept this amount before payment. Original installments remain unchanged.',
      amount: money(cityDelta.toString()), amounts: current,
    });
  }
  snapshot.adjustments = adjustments;
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
  if (!schedule) {
    const payments = await db.payment.findMany({ where: { idEst: estimateId,
      type: { in: milestone === 'RELEASE' ? ['MATERIAL'] : ['INSTALLATION', 'INSTALLATION_DEPOSIT'] },
    } });
    if (payments.some(p => (hasRefundHistory(p) || p.refundReviewPending) && !paymentIsCovered(p))) {
      throw new BadRequestException('The required payment has a refund or balance under review. Resolve it before continuing.');
    }
  }
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
    'PERMIT_PAYMENT_PENDING',
    'PERMIT_PROCESSING',
    'MATERIAL_PAYMENT_PENDING',
    'MATERIAL_PAID',
    'INSTALLATION_PAYMENT_PENDING',
    'INSTALLATION_PAID',
  ];
  if (!mutable.includes(job.status)) return false;
  const ready = [
    'Preparing for pickup',
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

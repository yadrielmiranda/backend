import { AccountedPayment, decimalAmount, paidPrincipal } from '@/payments/payment-accounting';
import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';

export const PENDING_ORDER_REVIEW = 'Pending order review';

export const milestones = ['ORDER', 'RELEASE', 'INSTALL', 'COMPLETE'] as const;
export type Milestone = (typeof milestones)[number];
export type Basis = 'PROJECT' | 'MATERIAL' | 'INSTALLATION';
export type PlanStep = { milestone: Milestone; basis: Basis; percent: number };
export type PlanDefinition = {
  withInstallation: PlanStep[];
  withoutInstallation: PlanStep[];
};
export const milestoneLabels: Record<Milestone, string> = {
  ORDER: 'Place order',
  RELEASE: 'Release materials',
  INSTALL: 'Before installation',
  COMPLETE: 'After installation',
};
export const milestoneDescriptions: Record<Milestone, string> = {
  ORDER: 'Required to place the order with the manufacturer.',
  RELEASE: 'Required before the materials can be picked up or delivered.',
  INSTALL: 'Required before installation can be scheduled or started.',
  COMPLETE: 'Due after installation is completed.',
};
export const defaultPlan: PlanDefinition = {
  withInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 100 },
    { milestone: 'INSTALL', basis: 'INSTALLATION', percent: 100 },
  ],
  withoutInstallation: [
    { milestone: 'ORDER', basis: 'MATERIAL', percent: 100 },
  ],
};

// Cada base suma exactamente 100%; evita cuotas huérfanas o posteriores a una instalación inexistente.
export function validatePlan(input: unknown): PlanDefinition {
  const definition = input as PlanDefinition;
  for (const variant of ['withInstallation', 'withoutInstallation'] as const) {
    const rows = definition?.[variant];
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 8)
      throw new BadRequestException(
        'Each payment plan variant needs between 1 and 8 installments.',
      );
    const totals = new Map<string, Decimal>();
    const keys = new Set<string>();
    for (const row of rows) {
      if (
        !milestones.includes(row?.milestone) ||
        !['PROJECT', 'MATERIAL', 'INSTALLATION'].includes(row?.basis) ||
        typeof row.percent !== 'number' ||
        !Number.isFinite(row.percent) ||
        row.percent <= 0 ||
        row.percent > 100 ||
        new Decimal(row.percent).decimalPlaces() > 2
      )
        throw new BadRequestException(
          'Invalid installment: select a milestone, a basis and a percentage from 0.01 to 100.',
        );
      if (
        variant === 'withoutInstallation' &&
        (row.basis !== 'MATERIAL' ||
          !['ORDER', 'RELEASE'].includes(row.milestone))
      )
        throw new BadRequestException(
          'Material-only plans can charge materials at order placement or release.',
        );
      if (
        row.basis === 'MATERIAL' &&
        !['ORDER', 'RELEASE'].includes(row.milestone)
      )
        throw new BadRequestException(
          'Materials must be covered by the release milestone.',
        );
      const key = `${row.milestone}:${row.basis}`;
      if (keys.has(key))
        throw new BadRequestException(
          'Combine duplicate installments for the same basis and milestone.',
        );
      keys.add(key);
      totals.set(
        row.basis,
        (totals.get(row.basis) ?? new Decimal(0)).add(row.percent),
      );
    }
    if (!rows.some((row) => row.milestone === 'ORDER'))
      throw new BadRequestException(
        'An initial order installment is required.',
      );
    if (totals.has('PROJECT') && totals.size > 1)
      throw new BadRequestException(
        'Use project percentages or separate material and installation percentages.',
      );
    if (
      variant === 'withInstallation' &&
      !totals.has('PROJECT') &&
      (!totals.has('MATERIAL') || !totals.has('INSTALLATION'))
    )
      throw new BadRequestException(
        'Separate plans must include both materials and installation.',
      );
    if ([...totals.values()].some((value) => !value.eq(100)))
      throw new BadRequestException(
        'Percentages must total 100% for each basis.',
      );
  }
  return Object.fromEntries(
    ['withInstallation', 'withoutInstallation'].map((key) => [
      key,
      definition[key as keyof PlanDefinition]
        .map((row) => ({
          milestone: row.milestone,
          basis: row.basis,
          percent: row.percent,
        }))
        .sort(
          (a, b) =>
            milestones.indexOf(a.milestone) - milestones.indexOf(b.milestone),
        ),
    ]),
  ) as PlanDefinition;
}

export type ScheduleRow = {
  kind?: 'CITY_FEE';
  sequence: number;
  milestone: Milestone;
  title: string;
  description: string;
  amount: string;
};
export type ScheduleAmounts = {
  material: string;
  installation: string;
  permit: string;
  city: string;
};
export type PlanSnapshot = {
  version: 1;
  planId: number | null;
  name: string;
  definition: PlanDefinition;
  locked?: { amounts: ScheduleAmounts; rows: ScheduleRow[]; at: string };
  adjustments?: Array<ScheduleRow & { amounts: ScheduleAmounts }>;
};
export function planSnapshot(value: unknown): PlanSnapshot | null {
  const snapshot = value as PlanSnapshot;
  return snapshot?.version === 1 && snapshot.definition ? snapshot : null;
}
export const money = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
export const sumAmounts = (a: ScheduleAmounts) =>
  new Decimal(a.material).add(a.installation).add(a.permit).add(a.city);

export function planRows(
  snapshot: PlanSnapshot,
  amounts: ScheduleAmounts,
  installation: boolean,
): ScheduleRow[] {
  const steps =
    snapshot.definition[
      installation ? 'withInstallation' : 'withoutInstallation'
    ];
  const allocated: Partial<Record<Basis, Decimal>> = {};
  const rows: ScheduleRow[] = [];
  steps.forEach((step, index) => {
    const base =
      step.basis === 'PROJECT'
        ? sumAmounts(amounts)
        : new Decimal(
            step.basis === 'MATERIAL' ? amounts.material : amounts.installation,
          );
    const last = !steps
      .slice(index + 1)
      .some((next) => next.basis === step.basis);
    // El residuo de centavos se asigna a la última cuota de cada base.
    let amount = last
      ? base.minus(allocated[step.basis] ?? 0)
      : new Decimal(money(base.mul(step.percent).div(100)));
    amount = Decimal.max(
      0,
      Decimal.min(amount, base.minus(allocated[step.basis] ?? 0)),
    );
    allocated[step.basis] = (allocated[step.basis] ?? new Decimal(0)).add(
      amount,
    );
    let label = `${step.percent}% ${step.basis.toLowerCase()}`;
    if (index === 0 && !steps.some((row) => row.basis === 'PROJECT')) {
      amount = amount.add(amounts.permit).add(amounts.city);
      if (new Decimal(amounts.permit).add(amounts.city).gt(0))
        label += ' + permit / City Fee';
    }
    rows.push({
      sequence: index + 1,
      milestone: step.milestone,
      title: `${milestoneLabels[step.milestone]} · ${label}`,
      description: milestoneDescriptions[step.milestone],
      amount: money(amount),
    });
  });
  // Un solo cobro por hito: no se crea una orden pagando solo una de sus bases.
  return milestones
    .flatMap((milestone) => {
      const sameMilestone = rows.filter((row) => row.milestone === milestone);
      if (!sameMilestone.length) return [];
      return [
        {
          ...sameMilestone[0],
          title: `${milestoneLabels[milestone]} · ${sameMilestone.map((row) => row.title.split(' · ')[1]).join(' + ')}`,
          amount: money(
            sameMilestone.reduce(
              (sum, row) => sum.add(row.amount),
              new Decimal(0),
            ),
          ),
        },
      ];
    })
    .map((row, index) => ({ ...row, sequence: index + 1 }));
}

export type SchedulePayment = AccountedPayment & {
  type: string;
  status: string;
  sequence: number;
  baseAmount: any;
  stripeSessionId?: string | null;
  paidAt?: any;
};

// Los anticipos se aplican en orden. El recargo de tarjeta nunca cuenta como capital pagado.
export function allocateSchedule(
  rows: ScheduleRow[],
  payments: SchedulePayment[],
  available: Milestone[],
  hasOrder: boolean,
) {
  const paid = payments.filter((payment) => payment.status === 'PAID' || payment.netPaidBaseAmount != null);
  const deposit = paid
    .filter((p) => p.type === 'INSTALLATION_DEPOSIT')
    .reduce((sum, p) => sum.add(paidPrincipal(p)), new Decimal(0));
  const permit = paid
    .filter((p) => p.type === 'PERMIT')
    .reduce((sum, p) => sum.add(paidPrincipal(p)), new Decimal(0));
  const reductions = rows
    .filter((row) => new Decimal(row.amount).lt(0))
    .reduce((sum, row) => sum.minus(row.amount), new Decimal(0));
  const approvedCredits = payments.reduce((sum, p) => sum.add(decimalAmount(p.refundCreditAmount)), new Decimal(0));
  const advanceCredits = payments.filter(p => ['INSTALLATION_DEPOSIT', 'PERMIT'].includes(p.type))
    .reduce((sum, p) => sum.add(decimalAmount(p.refundCreditAmount)), new Decimal(0));
  let advanceReview = payments.filter(p => ['INSTALLATION_DEPOSIT', 'PERMIT'].includes(p.type) && p.refundReviewPending)
    .reduce((sum, p) => sum.add(decimalAmount(p.refundReviewBaseAmount)), new Decimal(0));
  let credit = deposit.add(permit).add(reductions).add(advanceCredits);
  const ordered = [...rows].sort(
    (a, b) =>
      milestones.indexOf(a.milestone) - milestones.indexOf(b.milestone) ||
      a.sequence - b.sequence,
  );
  const result = ordered.map((row) => {
    const matching = payments.filter(p => p.type === 'INSTALLMENT' && p.sequence === row.sequence);
    const approvedCredit = matching.reduce((sum, p) => sum.add(decimalAmount(p.refundCreditAmount)), new Decimal(0));
    const originalAmount = new Decimal(row.amount);
    const amount = originalAmount.lt(0) ? originalAmount : Decimal.max(0, originalAmount.minus(approvedCredit));
    if (amount.lt(0))
      return {
        ...row,
        paid: '0.00',
        credit: '0.00',
        balance: '0.00',
        status: 'CREDIT' as const,
      };
    const direct = paid
      .filter((p) => p.type === 'INSTALLMENT' && p.sequence === row.sequence)
      .reduce((sum, p) => sum.add(paidPrincipal(p)), new Decimal(0));
    credit = credit.add(Decimal.max(0, approvedCredit.minus(Decimal.max(0, originalAmount))));
    const applied = Decimal.min(credit, Decimal.max(0, amount.minus(direct)));
    credit = credit.minus(applied).add(Decimal.max(0, direct.minus(amount)));
    const balance = Decimal.max(0, amount.minus(direct).minus(applied));
    const directReview = matching.some(p => p.refundReviewPending && decimalAmount(p.refundReviewBaseAmount).gt(0));
    const affectedByAdvanceRefund = advanceReview.gt(0) && balance.gt(0);
    if (affectedByAdvanceRefund) advanceReview = Decimal.max(0, advanceReview.minus(balance));
    const review = directReview || affectedByAdvanceRefund;
    const cityFeeUnconfirmed = row.kind === 'CITY_FEE' && amount.gt(0) &&
      !matching.some(p => p.paidAt || p.status === 'PAID' || p.netPaidBaseAmount != null);
    return {
      ...row,
      amount: money(amount),
      originalAmount: row.amount,
      approvedCredit: money(approvedCredit),
      paid: money(direct),
      credit: money(applied),
      balance: money(balance),
      status: review ? ('REVIEW' as const) : balance.eq(0) && !cityFeeUnconfirmed
        ? ('PAID' as const)
        : available.includes(row.milestone)
          ? ('DUE' as const)
          : ('UPCOMING' as const),
    };
  });
  // Aunque el anticipo cubra todo, el dueño confirma la primera cuota para crear la orden.
  const first = result[0];
  const initialUnconfirmed =
    !hasOrder &&
    first &&
    !paid.some(
      (p) => p.type === 'INSTALLMENT' && p.sequence === first.sequence && (p.status === 'PAID' || p.paidAt || p.netPaidBaseAmount != null),
    );
  const next = initialUnconfirmed
    ? available.includes('ORDER') && first.status !== 'REVIEW'
      ? first
      : null
    : (result.find((row) => row.status === 'DUE') ?? null);
  const installmentsPaid = paid
    .filter((p) => p.type === 'INSTALLMENT')
    .reduce((sum, p) => sum.add(paidPrincipal(p)), new Decimal(0));
  const total = Decimal.max(0, rows.reduce((sum, row) => sum.add(row.amount), new Decimal(0)).minus(approvedCredits));
  const received = deposit.add(permit).add(installmentsPaid);
  return {
    rows: result,
    next,
    refundReviewPending: payments.some(p => p.refundReviewPending),
    refunded: money(payments.reduce((sum, p) => sum.add(decimalAmount(p.refundedAmount)), new Decimal(0))),
    approvedRefundCredit: money(approvedCredits),
    total: money(total),
    paid: money(received),
    balance: money(Decimal.max(0, total.minus(received))),
    depositPaid: money(deposit),
    permitPaid: money(permit),
    creditBalance: money(Decimal.max(0, received.minus(total))),
  };
}

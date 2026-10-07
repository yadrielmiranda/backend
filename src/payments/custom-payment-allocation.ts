import { BadRequestException, ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { milestones } from '@/payment-plans/payment-plan';
import { cents, distributeCents, paidPrincipal, type AccountedPayment } from './payment-accounting';
import type { ProcessingComponents } from './processing-cost-snapshot';

type CustomSchedule = {
  fullBalance: { amount: string; sequences: number[] } | null;
  rows: Array<{ sequence: number; milestone: string; balance: string }>;
};

export function allocateCustomPayment(schedule: CustomSchedule | null, amount: number, expectedBalance?: number) {
  const validMoney = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
    value > 0 && new Decimal(value).decimalPlaces() <= 2 && Number.isSafeInteger(new Decimal(value).mul(100).toNumber());
  if (!validMoney(amount)) throw new BadRequestException('Enter a positive payment amount with at most two decimal places.');
  if (!validMoney(expectedBalance)) throw new BadRequestException('Review the approved project balance before entering a payment amount.');
  if (!schedule?.fullBalance) throw new ConflictException('A custom payment is not available. Refresh the approved payment schedule.');
  if (!new Decimal(expectedBalance).eq(schedule.fullBalance.amount))
    throw new ConflictException('The project balance changed. Refresh and review the updated amount before payment.');
  if (new Decimal(amount).gt(schedule.fullBalance.amount)) throw new BadRequestException('The payment amount cannot exceed the approved project balance.');
  const order = (milestone: string) => milestones.indexOf(milestone as typeof milestones[number]);
  const rows = schedule.rows.filter(row => schedule.fullBalance!.sequences.includes(row.sequence))
    .sort((a, b) => order(a.milestone) - order(b.milestone) || a.sequence - b.sequence);
  let remaining = cents(amount);
  const allocations: Array<{ sequence: number; amount: string }> = [];
  for (const row of rows) {
    if (!remaining) break;
    const allocated = Math.min(remaining, cents(row.balance));
    // A fully credited initial installment can still require explicit confirmation
    // before a subsequent payment creates the order or advances its workflow.
    allocations.push({ sequence: row.sequence, amount: new Decimal(allocated).div(100).toFixed(2) });
    remaining -= allocated;
  }
  if (remaining) throw new ConflictException('The approved installment balance changed. Refresh the payment schedule.');
  return allocations;
}

export function partialProcessingComponents(components: ProcessingComponents, amount: Decimal): ProcessingComponents {
  const keys = ['material', 'installation', 'permit', 'city', 'other'] as const;
  const portions = distributeCents(cents(amount), keys.map(key => cents(components[key])));
  return { ...components, ...Object.fromEntries(keys.map((key, index) => [key, new Decimal(portions[index]).div(100).toFixed(2)])) };
}

/** The obligation excludes credits from deposits/other rows, but includes this
 * payment's captured principal and approved refund reductions. */
export function installmentObligation(balance: Decimal, previous?: AccountedPayment | null): Decimal {
  return balance.add(paidPrincipal(previous ?? {})).add(String(previous?.refundCreditAmount ?? 0));
}

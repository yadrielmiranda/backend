import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const MAX_FACTORY_PAYMENT = new Prisma.Decimal('9999999999.99');

export function paymentAmount(value: string): Prisma.Decimal {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value))
    throw new BadRequestException('Enter an amount with at most two decimal places.');
  const amount = new Prisma.Decimal(value);
  if (amount.lte(0) || amount.gt(MAX_FACTORY_PAYMENT))
    throw new BadRequestException('The payment amount must be greater than zero and at most 9,999,999,999.99.');
  return amount;
}

export function paymentDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value || value < '1000-01-01')
    throw new BadRequestException('Enter a valid payment date.');
  return date;
}

export function importedFactoryTotal(value: Prisma.Decimal | null): Prisma.Decimal | null {
  if (value == null || !value.isFinite() || value.isNegative()) return null;
  // The source keeps 8 decimals; compare receipts against one cent-rounded total.
  const rounded = value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.gt(MAX_FACTORY_PAYMENT) ? null : rounded;
}

export function factoryBalance(total: Prisma.Decimal | null, amounts: Prisma.Decimal[]) {
  const paid = amounts.reduce((sum, amount) => sum.add(amount), new Prisma.Decimal(0));
  return { paid, remaining: total == null ? null : total.sub(paid) };
}

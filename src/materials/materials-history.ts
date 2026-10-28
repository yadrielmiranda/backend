import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export const materialMovementKinds = [
  'RECEIVE', 'INTERNAL_USE', 'OPEN', 'PACK', 'TRANSFER_OUT', 'TRANSFER_IN',
  'ADJUST', 'COUNT_ADJUSTMENT', 'SALE_DELIVERY',
] as const;

function filterText(value: unknown, limit: number, label: string) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > limit)
    throw new BadRequestException(`Invalid ${label} filter.`);
  return value.trim() || undefined;
}

function timestamp(value: unknown, label: string) {
  const input = filterText(value, 40, label);
  if (!input) return undefined;
  // Require an explicit timezone so the server's timezone never changes a date filter.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) throw new BadRequestException(`Invalid ${label} filter.`);
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const result = new Date(input);
  if (Number(year) < 1 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 ||
      Number(day) > days[Number(month) - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) ||
      !Number.isFinite(result.getTime()))
    throw new BadRequestException(`Invalid ${label} filter.`);
  return result;
}

export function materialHistoryWhere(query: Record<string, string>): Prisma.MaterialMovementWhereInput {
  const where: Prisma.MaterialMovementWhereInput = {};
  for (const key of ['productId', 'storeId'] as const) {
    const value = filterText(query[key], 20, key);
    if (!value) continue;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647)
      throw new BadRequestException('Invalid history filter.');
    where[key] = id;
  }
  const search = filterText(query.search, 150, 'material');
  if (search) where.product = { OR: [{ name: { contains: search } }, { code: { contains: search } }] };
  const recipient = filterText(query.recipient, 200, 'recipient');
  if (recipient) where.recipient = { contains: recipient };
  const kind = filterText(query.kind, 40, 'movement type');
  if (kind) {
    if (!(materialMovementKinds as readonly string[]).includes(kind))
      throw new BadRequestException('Invalid movement type filter.');
    where.kind = kind;
  }
  const from = timestamp(query.from, 'start date'), to = timestamp(query.to, 'end date');
  if (from && to && from >= to) throw new BadRequestException('The end date must be after the start date.');
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  return where;
}

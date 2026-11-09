import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const ROLE_MARKUP_PATTERN = /^-?\d{1,6}(?:\.\d{1,18})?$/;
export const ROLE_MARKUP_MESSAGE =
  'markup must fit within 6 integer and 18 decimal places.';

// Numeric payloads from older clients remain supported. Expand their exponent
// notation without converting exact decimal strings through a JavaScript number.
export function normalizeRoleMarkup(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Prisma.Decimal(value).toFixed();
  }
  return typeof value === 'string' ? value.trim() : value;
}

export function parseRoleMarkup(value: unknown): Prisma.Decimal {
  const normalized = normalizeRoleMarkup(value);
  if (typeof normalized !== 'string' || !ROLE_MARKUP_PATTERN.test(normalized)) {
    throw new BadRequestException(ROLE_MARKUP_MESSAGE);
  }
  return new Prisma.Decimal(normalized);
}

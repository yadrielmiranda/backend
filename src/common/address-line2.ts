import { BadRequestException } from '@nestjs/common';

/** Preserve omission on partial updates; explicit blank or null clears the field. */
export function normalizeAddressLine2(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length > 150) {
    throw new BadRequestException('Address details must be text with at most 150 characters.');
  }
  return value.trim() || null;
}

// Use the original value so implicit DTO conversion cannot turn numbers into text.
export function transformAddressLine2({ obj, key }: { obj: Record<string, unknown>; key: string }) {
  const value = obj[key];
  return typeof value === 'string' ? value.trim() || null : value;
}

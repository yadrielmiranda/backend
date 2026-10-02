import { BadRequestException } from '@nestjs/common';

export const MUNTIN_AVAILABILITIES = ['NONE', 'ALL', 'SELECTED'] as const;
export type MuntinAvailability = (typeof MUNTIN_AVAILABILITIES)[number];
export type MuntinAvailabilityPolicy = {
  muntinAvailability: MuntinAvailability;
  allowedMuntinTypeIds: number[];
};

export function resolveMuntinAvailability(
  current: MuntinAvailabilityPolicy,
  update: Partial<MuntinAvailabilityPolicy>,
): MuntinAvailabilityPolicy {
  const mode = update.muntinAvailability === undefined
    ? current.muntinAvailability : update.muntinAvailability;
  if (!MUNTIN_AVAILABILITIES.includes(mode))
    throw new BadRequestException('Invalid muntin availability.');

  const ids = update.allowedMuntinTypeIds === undefined
    ? current.allowedMuntinTypeIds : update.allowedMuntinTypeIds;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length)
    throw new BadRequestException('Muntin types must be unique positive integer IDs.');
  if (mode === 'SELECTED' && !ids.length)
    throw new BadRequestException('Select at least one allowed muntin type.');
  return {
    muntinAvailability: mode,
    allowedMuntinTypeIds: mode === 'SELECTED' ? [...ids].sort((a, b) => a - b) : [],
  };
}

export function withMuntinAvailability<T extends {
  muntinAvailability: MuntinAvailability;
  allowedMuntinTypes: Array<{ muntinTypeId: number }>;
}>(sysConf: T) {
  const { allowedMuntinTypes, ...fields } = sysConf;
  return {
    ...fields,
    allowedMuntinTypeIds: allowedMuntinTypes.map(link => link.muntinTypeId).sort((a, b) => a - b),
  };
}

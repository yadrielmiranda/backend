// Accepted only so obsolete clients receive a migration notice instead of a
// silently ignored update. These fields no longer define catalog permissions.
export const MUNTIN_AVAILABILITIES = ['NONE', 'ALL', 'SELECTED'] as const;
export type MuntinAvailability = (typeof MUNTIN_AVAILABILITIES)[number];

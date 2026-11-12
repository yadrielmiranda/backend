import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export const PHONE_VALIDATION_MESSAGE = 'Enter a valid phone number with its country calling code (for example, +13055551234).';

/** Normalize the complete contact number; do not extract numbers from other text. */
export function normalizePhoneToE164(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 80 || !/^\+?[\d\s().-]+$/.test(raw)) return null;
  const phone = parsePhoneNumberFromString(raw, { defaultCountry: 'US', extract: false });
  return phone && !phone.ext && phone.isValid() ? phone.number : null;
}

// Read the original input so implicit DTO conversion cannot accept numeric JSON.
export function transformPhone({ obj, key }: { obj: Record<string, unknown>; key: string }) {
  const value = obj[key];
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  return raw ? normalizePhoneToE164(raw) ?? raw : null;
}

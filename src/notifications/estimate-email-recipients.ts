import { isEmail } from 'class-validator';

export const MAX_ESTIMATE_EMAIL_RECIPIENTS = 10;
export const MAX_ESTIMATE_EMAIL_RECIPIENTS_INPUT_LENGTH = 4096;
export const ESTIMATE_EMAIL_RECIPIENTS_ERROR =
  'Enter one valid recipient email in To and comma-separated emails in CC, up to 10 recipients total.';

type EstimateEmailRecipients = { to: string; cc: string[]; all: string[] };

/** Only the manual estimate-sharing flow accepts a separate comma-separated CC list. */
export function parseEstimateEmailRecipients(to: unknown, cc?: unknown): EstimateEmailRecipients | null {
  if (typeof to !== 'string' ||
    to.length > MAX_ESTIMATE_EMAIL_RECIPIENTS_INPUT_LENGTH || /[\r\n]/.test(to) ||
    (cc !== undefined && (typeof cc !== 'string' ||
      cc.length > MAX_ESTIMATE_EMAIL_RECIPIENTS_INPUT_LENGTH || /[\r\n]/.test(cc)))) {
    return null;
  }
  const primary = to.trim().toLowerCase();
  if (!primary || primary.length > 254 || !isEmail(primary)) return null;
  const recipients = new Set([primary]);
  const copies = typeof cc === 'string' && cc.trim() ? cc.split(',') : [];
  for (const part of copies) {
    const address = part.trim().toLowerCase();
    if (!address || address.length > 254 || !isEmail(address)) return null;
    recipients.add(address);
    if (recipients.size > MAX_ESTIMATE_EMAIL_RECIPIENTS) return null;
  }
  const all = [...recipients];
  return { to: primary, cc: all.slice(1), all };
}

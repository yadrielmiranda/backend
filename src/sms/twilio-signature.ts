import { createHmac, timingSafeEqual } from 'node:crypto';

// Valida el formato application/x-www-form-urlencoded definido por Twilio.
export function validateTwilioSignature(
  token: string,
  publicUrl: string,
  signature: string | undefined,
  parameters: Record<string, unknown>,
): parameters is Record<string, string> {
  if (!token || !publicUrl || !signature || !/^[A-Za-z0-9+/]{27}=$/.test(signature)) return false;
  if (Object.values(parameters).some((value) => typeof value !== 'string')) return false;
  const data = Object.keys(parameters).sort().reduce((value, key) => value + key + parameters[key], publicUrl);
  const expected = createHmac('sha1', token).update(data, 'utf8').digest();
  const supplied = Buffer.from(signature, 'base64');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

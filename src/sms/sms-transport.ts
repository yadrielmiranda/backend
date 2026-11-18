import axios, { AxiosResponse } from 'axios';

export type SmsSettings = { account: string; key: string; secret: string; service: string };
export type SmsDeliveryResult =
  | { status: 'ACCEPTED'; providerMessageSid: string }
  | { status: 'RETRY' | 'FAILED' | 'UNKNOWN' | 'UNAVAILABLE'; errorCode: string; providerMessageSid?: string };
type TwilioResponse = { sid?: string; status?: string; code?: number; error_code?: number };

/** One provider attempt. Callers enforce environment, consent, claiming and retries. */
export async function deliverSms(settings: SmsSettings, phone: string, message: string): Promise<SmsDeliveryResult> {
  const body = new URLSearchParams({ To: phone, MessagingServiceSid: settings.service, Body: message });
  let response: AxiosResponse<TwilioResponse>;
  try {
    response = await axios.post<TwilioResponse>(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.account}/Messages.json`,
      body.toString(),
      {
        auth: { username: settings.key, password: settings.secret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000, maxRedirects: 0, validateStatus: () => true,
      },
    );
  } catch {
    return { status: 'UNKNOWN', errorCode: 'NETWORK_ERROR' };
  }
  const sid = typeof response.data?.sid === 'string' && /^(?:SM|MM)[\da-f]{32}$/i.test(response.data.sid)
    ? response.data.sid : undefined;
  const code = response.data?.code ?? response.data?.error_code;
  const errorCode = Number.isInteger(code) ? String(code) : `HTTP_${response.status}`;
  if (response.status >= 200 && response.status < 300) {
    if (!sid) return { status: 'UNKNOWN', errorCode: 'INVALID_PROVIDER_RESPONSE' };
    if (['failed', 'undelivered', 'canceled'].includes(response.data.status ?? ''))
      return { status: 'FAILED', errorCode, providerMessageSid: sid };
    return { status: 'ACCEPTED', providerMessageSid: sid };
  }
  // Only an explicit unprocessed rate-limit response is safe to retry.
  if (response.status === 429 && !sid) return { status: 'RETRY', errorCode };
  return { status: response.status >= 500 || sid ? 'UNKNOWN' : 'FAILED', errorCode, providerMessageSid: sid };
}

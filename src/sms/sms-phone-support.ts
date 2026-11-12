export const SMS_UNSUPPORTED_PHONE_MESSAGE = 'SMS is not currently available for this phone number. You can use your account without enabling SMS.';

// Preserve the existing delivery scope while account contact numbers become international.
export function supportsSmsPhone(phone: unknown): phone is string {
  return typeof phone === 'string' && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone);
}

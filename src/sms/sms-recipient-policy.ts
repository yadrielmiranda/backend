import { supportsSmsPhone } from './sms-phone-support';

export type ServiceSmsRecipient = {
  phone: string;
  isActive: boolean;
  deletedAt: Date | null;
  smsConsent: {
    enabled: boolean;
    phone: string;
    consentedAt: Date | null;
    revokedAt: Date | null;
    consentVersion: string | null;
    consentText: string | null;
  } | null;
};

/** Service permission is independent of promotional consent and the account role. */
export function hasActiveServiceSmsConsent<T extends ServiceSmsRecipient>(
  user: T | null | undefined,
): user is T & {
  smsConsent: NonNullable<T['smsConsent']> & {
    consentedAt: Date;
    consentVersion: string;
    consentText: string;
  };
} {
  return Boolean(
    user?.isActive && !user.deletedAt && supportsSmsPhone(user.phone) &&
    user.smsConsent?.enabled && user.smsConsent.phone === user.phone &&
    user.smsConsent.consentedAt && user.smsConsent.consentVersion &&
    user.smsConsent.consentText && !user.smsConsent.revokedAt,
  );
}

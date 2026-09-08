import type { Prisma } from '@prisma/client';

export async function revokeSmsConsent(
  tx: Prisma.TransactionClient,
  userId: number,
  action: 'PHONE_CHANGED' | 'ACCOUNT_DISABLED',
) {
  const consent = await tx.smsConsent.findUnique({ where: { userId } });
  if (!consent?.enabled) return;
  const now = new Date();
  await tx.smsConsent.update({
    where: { userId },
    data: { enabled: false, revokedAt: now },
  });
  await tx.smsConsentEvent.create({
    data: {
      userId,
      phone: consent.phone,
      action,
      consentVersion: consent.consentVersion,
      consentText: consent.consentText,
      createdAt: now,
    },
  });
}

import type { Prisma } from '@prisma/client';

export async function revokeSmsConsent(
  tx: Prisma.TransactionClient,
  userId: number,
  action: 'PHONE_CHANGED' | 'ACCOUNT_DISABLED',
) {
  const consent = await tx.smsConsent.findUnique({ where: { userId } });
  if (!consent?.enabled && !consent?.promotionsEnabled) return;
  const now = new Date();
  await tx.smsConsent.update({
    where: { userId },
    data: {
      ...(consent.enabled ? { enabled: false, revokedAt: now } : {}),
      ...(consent.promotionsEnabled ? { promotionsEnabled: false, promotionsRevokedAt: now } : {}),
    },
  });
  // Se conserva la prueba y fecha originales de cada categoría.
  if (consent.enabled) {
    await tx.smsConsentEvent.create({
      data: {
        userId, phone: consent.phone, action, category: 'SERVICE',
        consentVersion: consent.consentVersion,
        consentText: consent.consentText, createdAt: now,
      },
    });
  }
  if (consent.promotionsEnabled) {
    await tx.smsConsentEvent.create({
      data: {
        userId, phone: consent.phone, action, category: 'PROMOTIONAL',
        consentVersion: consent.promotionsConsentVersion,
        consentText: consent.promotionsConsentText, createdAt: now,
      },
    });
  }
}

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, PlatformTermsVersion } from '@prisma/client';

export const PLATFORM_TERMS_CONSENT =
  'I have read and accept the Terms and Conditions for using the platform.';

export function needsPlatformTerms(user: { role: { name: string }; dealerMode?: string | null }) {
  // Un dealer sin clasificación histórica se trata como externo, igual que en precios.
  return user.role.name === 'client' ||
    (user.role.name === 'dealer' && user.dealerMode !== 'INTERNAL');
}

export async function lockCurrentPlatformTerms(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM PlatformTermsState WHERE id = 1 FOR UPDATE`;
  const state = await tx.platformTermsState.findUniqueOrThrow({
    where: { id: 1 }, include: { currentVersion: true },
  });
  return state.currentVersion;
}

export function requireCurrentAcceptance(
  current: PlatformTermsVersion | null,
  accepted: unknown,
  versionId: unknown,
) {
  if (!current) return;
  // Nunca convertir "false", 1 u otros valores en una aceptación expresa.
  if (accepted !== true)
    throw new BadRequestException({
      code: 'PLATFORM_TERMS_REQUIRED',
      message: 'Read and accept the Terms and Conditions to continue.',
    });
  if (versionId !== current.id)
    throw new ConflictException({
      code: 'PLATFORM_TERMS_CHANGED',
      message: 'The Terms and Conditions changed. Review the current version before accepting.',
    });
}

export async function savePlatformTermsAcceptance(
  tx: Prisma.TransactionClient,
  userId: number,
  versionId: number,
  source: 'REGISTRATION' | 'ACCOUNT',
) {
  // Los reintentos conservan la fecha y procedencia de la aceptación original.
  return tx.platformTermsAcceptance.upsert({
    where: { userId_versionId: { userId, versionId } },
    create: { userId, versionId, source },
    update: {},
  });
}

export function platformTermsInfo(version: PlatformTermsVersion | null) {
  if (!version) return null;
  return {
    id: version.id,
    version: version.id,
    name: version.originalName,
    sizeBytes: version.sizeBytes,
    publishedAt: version.publishedAt,
    consentText: version.consentText,
  };
}

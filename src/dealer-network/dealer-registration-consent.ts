import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockCurrentPlatformTerms, requireCurrentAcceptance, savePlatformTermsAcceptance } from '@/platform-terms/platform-terms.policy';
import { SMS_UNSUPPORTED_PHONE_MESSAGE, supportsSmsPhone } from '@/sms/sms-phone-support';
import { getSmsProgram } from '@/sms/sms-program';
import type { SubmitDealerRegistrationDto } from './dealer-network.dto';

export const registrationConsentSelect = {
  phone: true, email: true, createdAt: true,
  serviceSmsAccepted: true, promotionalSmsAccepted: true, smsConsentVersion: true,
  smsConsentText: true, smsConsentedAt: true, termsVersionId: true, termsAcceptedAt: true,
} satisfies Prisma.DealerRegistrationRequestSelect;

type ConsentSnapshot = Prisma.DealerRegistrationRequestGetPayload<{ select: typeof registrationConsentSelect }>;

export async function captureDealerRegistrationConsent(tx: Prisma.TransactionClient, dto: SubmitDealerRegistrationDto) {
  const terms = await lockCurrentPlatformTerms(tx);
  requireCurrentAcceptance(terms, dto.platformTermsAccepted, dto.platformTermsVersionId);
  for (const choice of [dto.serviceConsent, dto.promotionsConsent]) {
    if (choice !== undefined && typeof choice !== 'boolean') {
      throw new BadRequestException('SMS preferences must be boolean values.');
    }
  }
  const serviceSmsAccepted = dto.serviceConsent === true;
  const promotionalSmsAccepted = dto.promotionsConsent === true;
  const wantsSms = serviceSmsAccepted || promotionalSmsAccepted;
  const program = await getSmsProgram(tx);
  if (wantsSms) {
    if (!supportsSmsPhone(dto.phone)) throw new BadRequestException(SMS_UNSUPPORTED_PHONE_MESSAGE);
    if (dto.consentVersion !== program.dealerRegistration.version) {
      throw new ConflictException({
        code: 'CONSENT_VERSION_CHANGED',
        message: 'The SMS terms changed. Review them and select your preferences again.',
      });
    }
    if (await tx.smsPhoneBlock.findUnique({ where: { phone: dto.phone }, select: { phone: true } })) {
      throw new ConflictException('SMS is blocked after a STOP request. Leave both SMS options unchecked to submit your application.');
    }
  }
  const now = new Date();
  return {
    serviceSmsAccepted, promotionalSmsAccepted,
    smsConsentVersion: program.dealerRegistration.version,
    smsConsentText: JSON.stringify({
      source: 'DEALER_REGISTRATION', channel: 'SMS', serviceSmsAccepted, promotionalSmsAccepted,
      registration: program.dealerRegistration, disclosure: program.disclosure, terms: program.terms, privacy: program.privacy,
    }),
    smsConsentedAt: wantsSms ? now : null,
    termsVersionId: terms?.id ?? null, termsAcceptedAt: terms ? now : null,
  };
}

// A later START clears the carrier block but never renews an earlier opt-in.
async function stopAfterConsent(tx: Prisma.TransactionClient, phone: string, consentedAt: Date) {
  const block = await tx.smsPhoneBlock.findUnique({ where: { phone }, select: { createdAt: true } });
  if (block) return block.createdAt;
  const stop = await tx.smsConsentEvent.findFirst({
    where: { phone, action: 'PROVIDER_STOP', createdAt: { gte: consentedAt } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  return stop?.createdAt ?? null;
}

export async function dealerRegistrationSmsStopped(tx: Prisma.TransactionClient, phone: string, consentedAt: Date) {
  return (await stopAfterConsent(tx, phone, consentedAt)) !== null;
}

export async function applyDealerRegistrationConsent(tx: Prisma.TransactionClient, userId: number, request: ConsentSnapshot) {
  if (request.termsVersionId && request.termsAcceptedAt) {
    await savePlatformTermsAcceptance(tx, userId, request.termsVersionId, 'REGISTRATION', request.termsAcceptedAt);
  }
  const { phone, email, smsConsentVersion: version, smsConsentText: text, smsConsentedAt: acceptedAt } = request;
  // Pending applications from before the consent form must never acquire a fabricated acceptance.
  if (!version || !text) return;
  await tx.registrationConsent.create({
    data: { userId, phone, email, serviceSmsAccepted: request.serviceSmsAccepted,
      promotionalSmsAccepted: request.promotionalSmsAccepted, serviceEmailAccepted: false, promotionalEmailAccepted: false,
      consentVersion: version, consentText: text, createdAt: acceptedAt ?? request.createdAt },
  });
  if (!acceptedAt || (!request.serviceSmsAccepted && !request.promotionalSmsAccepted)) return;

  const revokedAt = await stopAfterConsent(tx, phone, acceptedAt);
  await tx.smsConsent.create({
    data: {
      userId, phone, enabled: request.serviceSmsAccepted && !revokedAt,
      promotionsEnabled: request.promotionalSmsAccepted && !revokedAt,
      ...(request.serviceSmsAccepted && { consentVersion: version, consentText: text, consentedAt: acceptedAt, revokedAt }),
      ...(request.promotionalSmsAccepted && { promotionsConsentVersion: version, promotionsConsentText: text,
        promotionsConsentedAt: acceptedAt, promotionsRevokedAt: revokedAt }),
    },
  });
  const categories = [
    ...(request.serviceSmsAccepted ? ['SERVICE'] : []),
    ...(request.promotionalSmsAccepted ? ['PROMOTIONAL'] : []),
  ];
  await tx.smsConsentEvent.createMany({
    data: categories.map(category => ({ userId, phone, action: 'OPT_IN', category,
      consentVersion: version, consentText: text, createdAt: acceptedAt })),
  });
}

import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  agreementComparison,
  agreementMatches,
  loadAgreementContent,
} from './agreement-content';

// Se ejecuta dentro de la transacción de checkout, después de bloquear Estimate.
export async function requireSignedAgreementForPayment(
  db: Prisma.TransactionClient,
  estimateId: number,
  token: string,
  agreementId: string,
) {
  const current = await loadAgreementContent(db, estimateId, 'detailed');
  const estimate = current?.estimate;
  const mode = estimate?.publicTotalToken === token ? 'total' : 'detailed';
  if (
    !estimate?.publicTokenEnabled ||
    estimate.dealerModeSnapshot !== 'INTERNAL' ||
    ![estimate.publicToken, estimate.publicTotalToken].includes(token)
  )
    throw new ConflictException('Customer payment link not found.');
  const agreement = await db.estimateAgreement.findFirst({
    where: { id: agreementId, estimateId, pricingMode: mode },
    select: { id: true, signedAt: true, invalidatedAt: true },
  });
  if (
    !agreement?.signedAt ||
    agreement.invalidatedAt ||
    !agreementMatches(await agreementComparison(db, agreement.id), current)
  )
    throw new ConflictException(
      'Review and sign the current agreement before paying from this link.',
    );
}

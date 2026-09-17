import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  agreementComparison,
  agreementMatches,
  loadAgreementContent,
} from './agreement-content';

const signatureMessage =
  'Review and sign the current agreement before paying from this link.';

export type AgreementPaymentRequirement = {
  required: boolean;
  satisfied: boolean;
  signingUrl: string | null;
};

// La obligación nace de los documentos emitidos para el estimado, no de un
// agreementId enviado por el navegador ni del contrato general del dealer.
export async function getAgreementPaymentRequirement(
  db: Prisma.TransactionClient,
  estimateId: number,
  token: string,
  agreementId?: string,
): Promise<AgreementPaymentRequirement> {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    select: {
      publicTokenEnabled: true,
      dealerModeSnapshot: true,
      publicToken: true,
      publicTotalToken: true,
    },
  });
  if (
    !token ||
    !estimate?.publicTokenEnabled ||
    estimate.dealerModeSnapshot !== 'INTERNAL' ||
    ![estimate.publicToken, estimate.publicTotalToken].includes(token)
  )
    throw new ConflictException('Customer payment link not found.');
  const mode = estimate.publicTotalToken === token ? 'total' : 'detailed';
  // También se considera el historial invalidado: cambiar el estimado no
  // elimina una firma pendiente ni permite volver a utilizar un contrato viejo.
  const latest = await db.estimateAgreement.findFirst({
    where: { estimateId },
    orderBy: { revision: 'desc' },
    select: { contractId: true },
  });
  if (!latest) {
    if (agreementId) throw new ConflictException(signatureMessage);
    return { required: false, satisfied: true, signingUrl: null };
  }

  // Selección pequeña: no ordenar snapshots/PDFs dentro de MySQL.
  const candidates = await db.estimateAgreement.findMany({
    where: { estimateId, contractId: latest.contractId, invalidatedAt: null },
    orderBy: { revision: 'desc' },
    select: { id: true, pricingMode: true, signedAt: true, quoteFileKey: true },
  });
  const current = await loadAgreementContent(db, estimateId, 'detailed');
  const matches = new Map<string, boolean>();
  const isCurrent = async (id: string) => {
    if (!matches.has(id))
      matches.set(id, agreementMatches(await agreementComparison(db, id), current));
    return matches.get(id)!;
  };

  // El documento de regreso pertenece al mismo enlace y debe seguir vigente.
  // La evidencia de firma puede venir de la otra presentación del mismo acuerdo.
  if (agreementId) {
    const selected = candidates.find(a => a.id === agreementId && a.pricingMode === mode);
    if (!selected?.quoteFileKey || !(await isCurrent(selected.id)))
      throw new ConflictException(signatureMessage);
  }
  for (const candidate of candidates) {
    if (candidate.signedAt && candidate.quoteFileKey && await isCurrent(candidate.id))
      return { required: true, satisfied: true, signingUrl: null };
  }

  // Nunca revelar el token ni el desglose de Detailed Prices a un enlace Total.
  for (const candidate of candidates) {
    if (candidate.pricingMode === mode && candidate.quoteFileKey && await isCurrent(candidate.id))
      return {
        required: true,
        satisfied: false,
        signingUrl: `/public/estimates/${encodeURIComponent(token)}/agreements/${encodeURIComponent(candidate.id)}`,
      };
  }
  return { required: true, satisfied: false, signingUrl: null };
}

// Se ejecuta dentro de la transacción de checkout, después de bloquear Estimate,
// antes de crear o reanudar cualquier sesión. El depósito se excluye por tipo.
export async function requireSignedAgreementForPayment(
  db: Prisma.TransactionClient,
  estimateId: number,
  token: string,
  agreementId?: string,
) {
  const requirement = await getAgreementPaymentRequirement(db, estimateId, token, agreementId);
  if (requirement.required && !requirement.satisfied)
    throw new ConflictException(signatureMessage);
}

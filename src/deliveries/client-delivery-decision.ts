import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClientDeliveryChoice, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

export const clientAddressSelect = {
  street: true, addressLine2: true, city: true, state: true, postalCode: true,
} satisfies Prisma.UserSelect;

export const clientCoverageSelect = {
  ...clientAddressSelect, id: true, role: { select: { name: true } },
  registrationConsent: { select: { consentText: true } },
  deliveryCoverageCheck: { select: { available: true, verificationKey: true, locationProof: true } },
} satisfies Prisma.UserSelect;

export type CoverageUser = Prisma.UserGetPayload<{ select: typeof clientCoverageSelect }>;
export type ClientAddress = { street: string; addressLine2: string | null; city: string; state: string; postalCode: string };
type Decision = { choice: ClientDeliveryChoice; verificationKey: string | null };

export function isPublicSignupClient(user: CoverageUser): boolean {
  if (user.role.name !== 'client' || !user.registrationConsent) return false;
  // Both public flows keep consent evidence, and an administrator can subsequently change the account role.
  try { return JSON.parse(user.registrationConsent.consentText)?.source === 'REGISTRATION'; }
  catch { return false; }
}

export function savedClientAddress(user: CoverageUser): ClientAddress | null {
  const { street, addressLine2, city, state, postalCode } = user;
  return street?.trim() && city?.trim() && state?.trim() && postalCode?.trim()
    ? { street, addressLine2, city, state, postalCode } : null;
}

export function deliveryAddressKey(userId: number, address: ClientAddress, revision: number, locationProof?: string | null): string {
  return createHash('sha256').update(JSON.stringify([
    userId, address.street, address.addressLine2 ?? '', address.city, address.state, address.postalCode, revision,
    ...(locationProof ? [locationProof] : []),
  ])).digest('hex');
}

export async function clientCoverageStatus(
  db: Prisma.TransactionClient, user: CoverageUser, options: {
    eligible?: boolean; decision?: Decision | null; checkCoverage?: boolean;
  } = {},
) {
  const { eligible = true, decision, checkCoverage = false } = options;
  const publicClient = isPublicSignupClient(user);
  const applies = eligible && publicClient;
  const address = savedClientAddress(user);
  const canAddProfileAddress = publicClient && address === null;
  let available: boolean | null = null;
  let verificationKey: string | null = null;
  if (checkCoverage && applies && address && user.deliveryCoverageCheck) {
    const settings = await db.warehouseDeliverySettings.findUnique({ where: { id: 1 }, select: { revision: true } });
    if (settings && user.deliveryCoverageCheck.verificationKey === deliveryAddressKey(user.id, address, settings.revision, user.deliveryCoverageCheck.locationProof)) {
      available = user.deliveryCoverageCheck.available;
      verificationKey = user.deliveryCoverageCheck.verificationKey;
    }
  }
  const acknowledged: ClientDeliveryChoice | null = decision?.choice === 'PICKUP' ? 'PICKUP'
    : available === true && decision?.verificationKey === verificationKey ? 'DELIVERY' : null;
  // Address capture never chooses fulfillment. The client may request actual delivery on the ready order.
  const reviewComplete = !applies || address !== null || acknowledged === 'PICKUP';
  return { applies, address, available, verificationKey, acknowledged, reviewComplete, canAddProfileAddress };
}

export async function estimateClientCoverage(db: Prisma.TransactionClient, estimateId: number, ownerId?: number,
  checkCoverage = false) {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId, ...(ownerId !== undefined && { idUser: ownerId }) },
    select: {
      user: { select: clientCoverageSelect },
      order: { select: { id: true } },
      installationJob: { select: { status: true } },
      deliveryAcknowledgement: { select: { choice: true, verificationKey: true } },
      payments: { where: {
        type: { in: ['MATERIAL', 'INSTALLMENT'] },
        OR: [{ status: { in: ['PAID', 'REFUNDED'] } }, { paidAt: { not: null } },
          { netPaidBaseAmount: { gt: 0 } }, { receipts: { some: {} } }],
      }, select: { id: true }, take: 1 },
    },
  });
  if (!estimate) throw new NotFoundException('Estimate not found.');
  const activeInstallation = estimate.installationJob && estimate.installationJob.status !== 'CANCELED';
  const firstMaterialPayment = !activeInstallation && !estimate.order && !estimate.payments.length;
  return clientCoverageStatus(db, estimate.user, { eligible: firstMaterialPayment, decision: estimate.deliveryAcknowledgement, checkCoverage });
}

export async function assertClientDeliveryDecision(estimateId: number, db: Prisma.TransactionClient) {
  const status = await estimateClientCoverage(db, estimateId);
  if (!status.reviewComplete) {
    throw new ConflictException({
      code: 'CLIENT_DELIVERY_DECISION_REQUIRED',
      message: 'Before paying, add your address or confirm that you can pick up in Miami.',
    });
  }
}

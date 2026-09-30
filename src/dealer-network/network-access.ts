import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decimalAmount, paidPrincipal, type AccountedPayment } from '@/payments/payment-accounting';

const accessSelect = {
  parentDealerId: true, dealerMode: true, isActive: true, deletedAt: true, networkSuspended: true,
} satisfies Prisma.UserSelect;

// Dos superiores como máximo: dealer, subdealer y distribuidor.
export const networkParentSelect = {
  ...accessSelect, parentDealer: { select: accessSelect },
} satisfies Prisma.UserSelect;

type NetworkAccessState = {
  isActive?: boolean; deletedAt?: Date | null; networkSuspended?: boolean;
  parentDealer?: NetworkAccessState | null;
};

export function networkAccessBlocked(account: NetworkAccessState): boolean {
  let current: NetworkAccessState | null | undefined = account;
  for (let level = 0; current; level++, current = current.parentDealer) {
    if (level >= 3 || current.isActive === false || current.deletedAt) return true;
  }
  return false;
}

// La suspensión comercial permite entrar y terminar trabajos ya comprometidos.
export function networkSalesBlocked(account: NetworkAccessState): boolean {
  if (networkAccessBlocked(account)) return true;
  for (let current: NetworkAccessState | null | undefined = account; current; current = current.parentDealer) {
    if (current.networkSuspended) return true;
  }
  return false;
}

// Se consulta el estado vigente, nunca un valor guardado en el JWT.
export async function accountNetworkBlocked(db: Prisma.TransactionClient,
  account: NetworkAccessState & { id: number; parentDealerId?: number | null },
  commercial = false,
): Promise<boolean> {
  const blocked = commercial ? networkSalesBlocked : networkAccessBlocked;
  if (blocked(account)) return true;
  const seen = new Set([account.id]);
  let parentId = account.parentDealerId;
  while (parentId != null) {
    if (seen.size >= 3 || seen.has(parentId)) return true;
    seen.add(parentId);
    const parent = await db.user.findUnique({ where: { id: parentId }, select: accessSelect });
    if (!parent || blocked(parent)) return true;
    parentId = parent.parentDealerId;
  }
  return false;
}

type ExistingBusiness = {
  order?: unknown;
  payments?: Array<AccountedPayment & { paidAt?: Date | string | null }>;
};

export function hasExistingBusiness(estimate: ExistingBusiness): boolean {
  return Boolean(estimate.order || estimate.payments?.some(payment =>
    payment.status === 'PAID' || payment.status === 'REFUNDED' || payment.paidAt ||
    paidPrincipal(payment).gt(0) || decimalAmount(payment.refundedAmount).gt(0) ||
    decimalAmount(payment.refundCreditAmount).gt(0) || payment.refundReviewPending,
  ));
}

export async function estimateNewBusinessBlocked(db: Prisma.TransactionClient,
  estimate: ExistingBusiness & { user: NetworkAccessState & { id: number; parentDealerId?: number | null } },
): Promise<boolean> {
  return !hasExistingBusiness(estimate) && await accountNetworkBlocked(db, estimate.user, true);
}

export async function assertNetworkEstimateCanProceed(db: Prisma.TransactionClient,
  estimate: Parameters<typeof estimateNewBusinessBlocked>[1],
): Promise<void> {
  if (await estimateNewBusinessBlocked(db, estimate))
    throw new ConflictException('New business is suspended for this account. Existing orders and paid projects can continue.');
}

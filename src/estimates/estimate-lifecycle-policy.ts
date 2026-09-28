import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import {
  decimalAmount,
  paidPrincipal,
  type AccountedPayment,
} from '@/payments/payment-accounting';

export const CANCELED_ESTIMATE = 'Canceled';
export const CANCELED_ESTIMATE_MESSAGE =
  'This estimate is canceled. Reactivate and recalculate it before continuing.';

export function assertEstimateLifecycleAccess(
  estimate: { idUser: number } | null,
  actor: AuthUser,
) {
  if (
    !estimate ||
    (!isPrivileged(actor) &&
      !(actor.role?.name === 'dealer' && estimate.idUser === actor.id))
  )
    throw new NotFoundException('Estimate not found.');
}

export function assertEstimateNotCanceled(
  estimate: { status?: { name: string } | null } | null,
) {
  if (estimate?.status?.name === CANCELED_ESTIMATE)
    throw new ConflictException(CANCELED_ESTIMATE_MESSAGE);
}

// Incluye recibos y devoluciones: cancelar no debe ocultar dinero ya recibido,
// aunque el saldo neto haya vuelto a cero o la cuota se haya reabierto.
export function assertNoEstimatePaymentHistory(
  payments: Array<
    AccountedPayment & {
      paidAt?: Date | string | null;
      receipts?: Array<{ id: number }>;
    }
  >,
) {
  if (
    payments.some(
      (payment) =>
        ['PAID', 'REFUNDED'].includes(payment.status ?? '') ||
        payment.paidAt ||
        payment.receipts?.length ||
        paidPrincipal(payment).gt(0) ||
        decimalAmount(payment.refundedAmount).gt(0) ||
        decimalAmount(payment.refundCreditAmount).gt(0) ||
        payment.refundReviewPending,
    )
  )
    throw new ConflictException(
      'This estimate has payment or refund history and cannot be canceled or reactivated here.',
    );
}

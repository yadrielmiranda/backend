import { DeliveryStatus, DeliveryType, PaymentStatus } from '@prisma/client';

export type DeliveryToPickupBlockReason =
  | 'NOT_STANDARD'
  | 'NOT_AWAITING_PAYMENT'
  | 'ACTIVE_CHECKOUT'
  | 'ALREADY_PAID';

type DeliveryPaymentState = {
  type: DeliveryType;
  status: DeliveryStatus;
  paidAt?: Date | null;
  payment?: {
    status: PaymentStatus;
    stripeSessionId?: string | null;
  } | null;
};

/**
 * A standard delivery may be replaced by pickup only before funds are paid and
 * while no Stripe checkout is active. Canceled, expired and failed attempts do
 * not lock the fulfillment choice.
 */
export function deliveryToPickupBlockReason(
  delivery: DeliveryPaymentState,
): DeliveryToPickupBlockReason | null {
  if (delivery.type !== DeliveryType.STANDARD) return 'NOT_STANDARD';

  if (delivery.paidAt || delivery.payment?.status === PaymentStatus.PAID) {
    return 'ALREADY_PAID';
  }

  if (delivery.payment?.status === PaymentStatus.REFUNDED) {
    return 'ALREADY_PAID';
  }

  if (delivery.status !== DeliveryStatus.PAYMENT_DUE) {
    return 'NOT_AWAITING_PAYMENT';
  }

  if (
    delivery.payment?.status === PaymentStatus.PENDING &&
    Boolean(delivery.payment.stripeSessionId)
  ) {
    return 'ACTIVE_CHECKOUT';
  }

  return null;
}

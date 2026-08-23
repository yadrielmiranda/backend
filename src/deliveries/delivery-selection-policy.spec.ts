import { DeliveryStatus, DeliveryType, PaymentStatus } from '@prisma/client';
import { deliveryToPickupBlockReason } from './delivery-selection-policy';

describe('delivery selection policy', () => {
  const standardDelivery = {
    type: DeliveryType.STANDARD,
    status: DeliveryStatus.PAYMENT_DUE,
    paidAt: null,
    payment: null,
  };

  it('allows an unpaid standard delivery to be replaced by pickup', () => {
    expect(deliveryToPickupBlockReason(standardDelivery)).toBeNull();
  });

  it.each([
    PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED,
    PaymentStatus.FAILED,
  ])('allows pickup after a %s checkout attempt is closed', (status) => {
    expect(
      deliveryToPickupBlockReason({
        ...standardDelivery,
        payment: { status, stripeSessionId: null },
      }),
    ).toBeNull();
  });

  it('blocks pickup while a Stripe checkout is active', () => {
    expect(
      deliveryToPickupBlockReason({
        ...standardDelivery,
        payment: {
          status: PaymentStatus.PENDING,
          stripeSessionId: 'cs_test_active',
        },
      }),
    ).toBe('ACTIVE_CHECKOUT');
  });

  it.each([PaymentStatus.PAID, PaymentStatus.REFUNDED])(
    'does not automatically replace a delivery that reached %s',
    (status) => {
      expect(
        deliveryToPickupBlockReason({
          ...standardDelivery,
          payment: { status, stripeSessionId: null },
        }),
      ).toBe('ALREADY_PAID');
    },
  );

  it('blocks special delivery charges and deliveries already in progress', () => {
    expect(
      deliveryToPickupBlockReason({
        ...standardDelivery,
        type: DeliveryType.PRE_DELIVERY,
      }),
    ).toBe('NOT_STANDARD');
    expect(
      deliveryToPickupBlockReason({
        ...standardDelivery,
        status: DeliveryStatus.READY_TO_SCHEDULE,
      }),
    ).toBe('NOT_AWAITING_PAYMENT');
  });
});

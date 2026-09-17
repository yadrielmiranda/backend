import { PaymentMethod } from '@prisma/client';
import type Stripe from 'stripe';

export function stripePaymentMethod(
  charge?: Pick<Stripe.Charge, 'payment_method_details'> | null,
) {
  const details = charge?.payment_method_details;
  const type = details?.type ?? null;
  const group =
    details?.link?.funding_source_group ??
    details?.card?.wallet?.link?.funding_source_group ??
    null;
  const link =
    type === 'link' ||
    details?.card?.wallet?.type === 'link' ||
    details?.card?.brand === 'link';
  let paymentMethod: PaymentMethod = PaymentMethod.OTHER;
  let paymentMethodLabel = 'Stripe';
  // Link puede informar type=card aunque los fondos provengan de un banco.
  if (link) {
    if (group === 'lfsg_003') {
      paymentMethod = PaymentMethod.BANK;
      paymentMethodLabel = 'Bank (Link)';
    } else if (group === 'lfsg_000') {
      paymentMethod = PaymentMethod.CARD;
      paymentMethodLabel = 'Card (Link)';
    } else paymentMethodLabel = group === 'lfsg_004' ? 'Klarna (Link)' : 'Link';
  } else if (type === 'card' || type === 'card_present') {
    paymentMethod = PaymentMethod.CARD;
    paymentMethodLabel = 'Card';
  } else if (type === 'us_bank_account' || type === 'ach_debit') {
    paymentMethod = PaymentMethod.ACH;
    paymentMethodLabel = 'Bank (ACH)';
  } else if (
    ['customer_balance', 'bank_transfer', 'ach_credit_transfer'].includes(
      type ?? '',
    )
  ) {
    paymentMethod = PaymentMethod.BANK;
    paymentMethodLabel = 'Bank transfer';
  } else if (type) {
    paymentMethodLabel =
      type === 'klarna' ? 'Klarna' : 'Stripe — ' + type.replace(/_/g, ' ');
  }
  return {
    paymentMethod,
    paymentMethodLabel,
    stripeMethodType: type,
    stripeFundingSourceGroup: group,
  };
}

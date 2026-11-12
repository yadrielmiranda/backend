import type { OrderFulfillmentMethod } from '@prisma/client';

type OrderStatusNotificationInput = {
  orderId: number;
  orderNumber: string | number;
  statusName: string;
  fulfillmentMethod: OrderFulfillmentMethod;
  installationActive: boolean;
};

export function orderStatusNotification(input: OrderStatusNotificationInput) {
  const needsSelection = input.statusName === 'Preparing for pickup'
    && input.fulfillmentMethod === 'UNDECIDED'
    && !input.installationActive;

  return needsSelection ? {
    message: `Your order #${input.orderNumber} is preparing for pickup. Please choose Pickup or Delivery to let us know how you will receive it.`,
    actionUrl: `/orders/${input.orderId}#pickup-delivery`,
    actionLabel: 'Choose pickup or delivery',
  } : {
    message: `The status of your order #${input.orderNumber} has changed to "${input.statusName}".`,
    actionUrl: `/orders/${input.orderId}`,
    actionLabel: 'Open order',
  };
}

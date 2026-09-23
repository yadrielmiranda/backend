import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { assertScheduleMilestone } from '@/payment-plans/payment-schedule';
import {
  decimalAmount,
  paidPrincipal,
  paymentIsCovered,
} from '@/payments/payment-accounting';
import { discountedInstallationTotal } from '@/estimates/discounts/estimate-discount';
import { installationDestination } from './warehouse-installation';

// Una salida física conserva los requisitos comerciales de Pickup & Delivery.
export async function assertWarehouseRelease(
  tx: Prisma.TransactionClient,
  estimateId: number,
) {
  await tx.$queryRaw`SELECT id FROM Estimate WHERE id = ${estimateId} FOR UPDATE`;
  const order = await tx.order.findUnique({
    where: { idEst: estimateId },
    include: {
      status: true,
      payment: true,
      deliveries: { include: { payment: true } },
      estimate: {
        include: {
          installationJob: {
            include: {
              quotes: {
                where: { status: 'APPROVED' },
                orderBy: { version: 'desc' },
                take: 1,
              },
              payments: {
                where: {
                  type: { in: ['INSTALLATION', 'INSTALLATION_DEPOSIT'] },
                },
              },
            },
          },
        },
      },
    },
  });
  const preparingForCompanyFulfillment =
    order?.status.name === 'Preparing for pickup' &&
    ['COMPANY_DELIVERY', 'INSTALLATION_DELIVERY'].includes(
      order.fulfillmentMethod,
    );
  if (
    !order ||
    (!preparingForCompanyFulfillment &&
      ![
        'Ready to pick up',
        'Picked up',
        'Delivered',
        'Installation in progress',
        'Installed',
      ].includes(order.status.name))
  ) {
    throw new BadRequestException(
      'The order must be ready for its selected pickup, delivery or installation workflow before releasing parts.',
    );
  }
  if (order.fulfillmentMethod === 'UNDECIDED')
    throw new BadRequestException(
      'Choose Pickup or Delivery on the order before releasing parts.',
    );
  const schedule = await assertScheduleMilestone(tx, estimateId, 'RELEASE');
  if (!schedule && !paymentIsCovered(order.payment))
    throw new BadRequestException(
      'Material payment must be covered before releasing parts.',
    );
  const installation = order.estimate.installationJob;
  if (!schedule && installation && installation.status !== 'CANCELED') {
    const paid = installation.payments.reduce(
      (sum, p) =>
        sum.add(paidPrincipal(p)).add(decimalAmount(p.refundCreditAmount)),
      new Decimal(0),
    );
    if (
      !installation.quotes[0] ||
      paid.lt(discountedInstallationTotal(order.estimate, installation)) ||
      installation.payments.some((p) => p.refundReviewPending)
    ) {
      throw new BadRequestException(
        'Installation payment must be covered before releasing parts.',
      );
    }
  }
  if (
    order.fulfillmentMethod === 'COMPANY_DELIVERY' &&
    !order.deliveries.some(
      (d) =>
        ['READY_TO_SCHEDULE', 'SCHEDULED', 'COMPLETED'].includes(d.status) &&
        paymentIsCovered(d.payment),
    )
  )
    throw new BadRequestException(
      'Delivery payment must be covered before releasing parts.',
    );
  return {
    fulfillmentMethod: order.fulfillmentMethod,
    installationDeliveryCovered: order.deliveries.every((delivery) =>
      delivery.type !== 'INSTALLATION_OVERRIDE' || delivery.status === 'CANCELED' || paymentIsCovered(delivery.payment)),
    installation: ['INSTALLATION_DELIVERY', 'COMPANY_DELIVERY'].includes(order.fulfillmentMethod)
      ? installationDestination(installation) : null,
  };
}

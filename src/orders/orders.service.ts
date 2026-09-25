import { decimalAmount, hasRefundHistory, paidPrincipal, remainingRefundBalance } from '@/payments/payment-accounting';
import { buildDealerEarningsReport } from '@/common/dealer-earnings';
import { assertScheduleMilestone, buildPaymentSchedule, getPaymentSchedule } from '@/payment-plans/payment-schedule';
// @/orders/orders.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  GlobalParameterKey,
  InstallationJobStatus,
  Order,
  OrderExtraChargeStatus,
  OrderFulfillmentMethod,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { UpdateOrderDto } from './dto/update-order.dto';
import { NotificationsService } from '@/notifications/notifications.service';
import { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';
import { LogsService } from '@/logs/logs.service';
import { InstallationWorkflowService } from '@/installation/installation-workflow.service';
import {
  CreateOrderExtraChargeDto,
  OrderExtraChargeDecision,
  RespondOrderExtraChargeDto,
} from './dto/order-extra-charge.dto';
import {
  canCreateInstallationExtraCharge,
  nextManualOrderStatus,
} from '@/installation/installation-flow-policy';
import { calculateEstimateDiscount, discountedInstallationTotal } from '@/estimates/discounts/estimate-discount';
import { buildEstimateInstallationSummary, estimateInstallationSummarySelect } from '@/estimates/reporting/estimate-installation-summary';

const orderDetailsInclude = {
  estimate: { include: { payments: true, installationJob: { include: { quotes: { orderBy: { version: 'desc' as const }, take: 1 }, permit: true } } } },
  status: true,
  user: { include: { role: true } },
  payment: true,
  extraCharges: {
    orderBy: { sequence: 'asc' as const },
    include: {
      lines: { orderBy: { sortOrder: 'asc' as const } },
      payment: true,
    },
  },
  deliveries: {
    orderBy: { sequence: 'asc' as const },
    include: { payment: true },
  },
} satisfies Prisma.OrderInclude;

const orderListInclude = {
  ...orderDetailsInclude,
  estimate: {
    include: {
      payments: true,
      status: true,
      installationJob: {
        include: {
          permit: true,
          quotes: {
            orderBy: { version: 'desc' as const },
            select: estimateInstallationSummarySelect.quotes.select,
          },
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

function withOrderListSummary(order: Prisma.OrderGetPayload<{ include: typeof orderListInclude }>) {
  const job = order.estimate.installationJob;
  const reportQuote = job?.quotes.find(quote => quote.status !== 'REJECTED');
  const installationSummary = buildEstimateInstallationSummary(job
    ? { ...job, quotes: reportQuote ? [reportQuote] : [] }
    : null);
  // El resumen usa la última cotización vigente, igual que Estimates; el pago
  // conserva la cotización más reciente para respetar sus reglas de aprobación.
  const estimate = {
    ...order.estimate,
    installationJob: job ? { ...job, quotes: job.quotes.slice(0, 1) } : null,
  };
  const schedule = buildPaymentSchedule({ ...estimate, order });
  const activeInstallation = job && job.status !== 'CANCELED';
  const unpaid = (charge: { status: string; total: Prisma.Decimal; payment: { status: string } | null }) =>
    charge.status === 'PAYMENT_DUE' && charge.total.gt(0) &&
    !['PAID', 'REFUNDED'].includes(charge.payment?.status ?? '');
  const installationCredit = order.estimate.payments
    .filter(payment => payment.installationJobId === job?.id && (payment.status === PaymentStatus.PAID || payment.netPaidBaseAmount != null) &&
      (payment.type === PaymentType.INSTALLATION_DEPOSIT || payment.type === PaymentType.INSTALLATION))
    .reduce((total, payment) => total.add(paidPrincipal(payment)).add(decimalAmount(payment.refundCreditAmount)), new Decimal(0));
  const legacyInstallationDue = !schedule && activeInstallation &&
    job.status === InstallationJobStatus.INSTALLATION_PAYMENT_PENDING &&
    discountedInstallationTotal(estimate, job).gt(installationCredit);
  const additionalPaymentDue = legacyInstallationDue || order.deliveries.some(unpaid) ||
    (activeInstallation && order.extraCharges.some(unpaid));
  let paymentAnchor: 'estimate-payment' | 'order-additional-payments' | null = null;
  if (!['Canceled', 'Cancelled'].includes(order.status.name)) {
    if (schedule?.next?.status === 'DUE' || order.estimate.payments.some(p => p.type !== PaymentType.INSTALLMENT && !p.refundReviewPending && hasRefundHistory(p) && remainingRefundBalance(p).gt(0) && (!schedule || [PaymentType.DELIVERY, PaymentType.EXTRA].includes(p.type as any)))) {
      paymentAnchor = 'estimate-payment';
    } else if (additionalPaymentDue) {
      paymentAnchor = 'order-additional-payments';
    }
  }
  return {
    ...order,
    ...buildDealerEarningsReport(order.estimate, order),
    paymentAnchor,
    estimate: {
      ...estimate,
      manualDiscountSummary: calculateEstimateDiscount(order.estimate),
      installationSummary,
    },
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private logsService: LogsService,
    private installationWorkflow: InstallationWorkflowService,
  ) {}

  async findAll() {
    const orders = await this.prisma.order.findMany({
      include: orderListInclude,
      orderBy: { date: 'desc' },
    });
    return orders.map(withOrderListSummary);
  }

  async findOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: orderDetailsInclude,
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);
    return { ...order, ...buildDealerEarningsReport(order.estimate, order), paymentSchedule: await getPaymentSchedule(this.prisma, order.idEst), estimate: { ...order.estimate, manualDiscountSummary: calculateEstimateDiscount(order.estimate) } };
  }

  async findAllStatuses(): Promise<OrderStatus[]> {
    return this.prisma.orderStatus.findMany({ orderBy: { id: 'asc' } });
  }

  async update(
    id: number,
    updateOrderDto: UpdateOrderDto,
    actor: AuthUser,
  ): Promise<Order> {
    if (updateOrderDto.poNumber !== undefined || updateOrderDto.rateReal !== undefined) {
      throw new BadRequestException('Import the factory JSON to set the PO and real factory cost.');
    }
    const current = await this.prisma.order.findUnique({
      where: { id },
      include: {
        status: true,
        estimate: {
          include: {
            user: true,
            installationJob: {
              include: {
                quotes: {
                  where: { status: 'APPROVED' },
                  orderBy: { version: 'desc' },
                  take: 1,
                },
                payments: {
                  where: {
                    type: {
                      in: [
                        PaymentType.INSTALLATION_DEPOSIT,
                        PaymentType.INSTALLATION,
                      ],
                    },
                    OR: [{ status: PaymentStatus.PAID }, { netPaidBaseAmount: { not: null } }],
                  },
                },
              },
            },
          },
        },
        user: { include: { role: true } },
      },
    });

    if (!current)
      throw new NotFoundException(`Order with ID #${id} not found.`);

    let nextStatus: { id: number; name: string } | null = null;

    if (updateOrderDto.statusId !== undefined) {
      nextStatus = await this.prisma.orderStatus.findUnique({
        where: { id: updateOrderDto.statusId },
        select: { id: true, name: true },
      });

      if (!nextStatus) {
        throw new NotFoundException(
          `OrderStatus with ID #${updateOrderDto.statusId} not found.`,
        );
      }
    }

    const statusWillChange =
      updateOrderDto.statusId !== undefined &&
      updateOrderDto.statusId !== current.statusId;

    // comentario en espanol: las transiciones operativas son secuenciales.
    if (statusWillChange && nextStatus) {
      if (['Installation in progress', 'Installed'].includes(nextStatus.name)) {
        throw new BadRequestException(
          'Start and complete installation from the Installation workflow.',
        );
      }

      let releaseCovered = true;
      if (
        ['In production', 'Awaiting release', 'Preparing for pickup'].includes(
          current.status.name,
        )
      ) {
        const releaseSchedule = await getPaymentSchedule(
          this.prisma,
          current.idEst,
        );
        releaseCovered = releaseSchedule ? releaseSchedule.canRelease : true;
      }
      const expected = nextManualOrderStatus(current.status.name, {
        releaseCovered,
        fulfillmentMethod: current.fulfillmentMethod,
      });
      if (expected !== nextStatus.name) {
        if (current.status.name === 'Awaiting release' && !releaseCovered) {
          throw new BadRequestException(
            'The release installment must be covered before this order can advance.',
          );
        }
        if (current.status.name === 'Preparing for pickup') {
          throw new BadRequestException(
            'Choose warehouse pickup or factory pickup before marking this order Ready to pick up. Delivery and installation continue from their own workflow.',
          );
        }
        if (current.status.name === 'Ready to pick up') {
          throw new BadRequestException(
            'Complete this order from its Pickup & Delivery workflow.',
          );
        }
        throw new BadRequestException(
          `Order status must advance from "${current.status.name}" to ${expected ? `"${expected}"` : 'its fulfillment workflow'}.`,
        );
      }

      if (nextStatus.name === 'Ready to pick up') {
        if (
          current.fulfillmentMethod !== OrderFulfillmentMethod.CUSTOMER_PICKUP &&
          current.fulfillmentMethod !== OrderFulfillmentMethod.FACTORY_PICKUP
        ) {
          throw new BadRequestException(
            'Ready to pick up is available only for warehouse pickup or factory pickup.',
          );
        }
        await assertScheduleMilestone(this.prisma, current.idEst, 'RELEASE');
      }

      const installation = current.estimate.installationJob;
      if (
        nextStatus.name === 'Delivered' &&
        installation &&
        installation.status !== InstallationJobStatus.CANCELED
      ) {
        const quote = installation.quotes[0];
        if (!quote) {
          throw new BadRequestException(
            'An approved installation quote is required before delivery.',
          );
        }
        const paidInstallation = installation.payments.reduce(
          (sum, payment) => sum.add(paidPrincipal(payment)).add(decimalAmount(payment.refundCreditAmount)),
          new Decimal(0),
        );
        const schedule = await assertScheduleMilestone(this.prisma, current.idEst, 'RELEASE');
        if (!schedule && paidInstallation.lt(discountedInstallationTotal(current.estimate, installation))) {
          throw new BadRequestException(
            'Installation must be paid before an installation order can be marked Delivered.',
          );
        }
      }

      const requiresPO = [
        'In production',
        'Awaiting release',
        'Preparing for pickup',
        'Ready to pick up',
        'Delivered',
      ].includes(nextStatus.name);

      if (requiresPO) {
        const finalPo = current.poNumber?.trim();

        if (!finalPo) {
          throw new BadRequestException(
            `PO Number is required before moving the order to "${nextStatus.name}".`,
          );
        }
      }
    }

    const data: Prisma.OrderUpdateInput = {
      ...(updateOrderDto.statusId !== undefined && {
        statusId: updateOrderDto.statusId,
      }),
      ...(statusWillChange && { updateStatus: new Date() }),
      ...(statusWillChange &&
        nextStatus?.name === 'Preparing for pickup' && {
          fulfillmentMethod:
            current.estimate.installationJob &&
            current.estimate.installationJob.status !==
              InstallationJobStatus.CANCELED
              ? OrderFulfillmentMethod.INSTALLATION_DELIVERY
              : OrderFulfillmentMethod.UNDECIDED,
          fulfillmentSelectedAt:
            current.estimate.installationJob &&
            current.estimate.installationJob.status !==
              InstallationJobStatus.CANCELED
              ? new Date()
              : null,
          pickupCompletedAt: null,
        }),
    };

    const updated = await this.prisma.order.update({
      where: { id },
      data,
      include: {
        status: true,
        estimate: { include: { user: true } },
        user: { include: { role: true } },
        payment: true,
        extraCharges: {
          orderBy: { sequence: 'asc' },
          include: {
            lines: { orderBy: { sortOrder: 'asc' } },
            payment: true,
          },
        },
        deliveries: {
          orderBy: { sequence: 'asc' },
          include: { payment: true },
        },
      },
    });

    // =====================================================
    // LOGS (EventLog + TempLog)
    // - EventLog: liviano y permanente
    // - TempLog: before/after/meta (temporal, para borrar cada X días)
    // =====================================================
    const actorRole = getRoleName(actor) ?? null;

    // comentario en espanol: calculamos qué campos realmente cambiaron (para auditoría)
    const changedFields: string[] = [];
    if (statusWillChange) changedFields.push('statusId');
    await this.logsService.log({
      action: 'UPDATE',
      entityType: 'Order',
      entityId: updated.id,
      userId: actor.id, // ✅ quien hizo el cambio
      message: statusWillChange
        ? `Order status changed: "${current.status?.name ?? ''}" -> "${updated.status?.name ?? ''}"`
        : 'Order updated',

      // comentario en espanol: snapshot corto, NO toda la orden
      before: {
        id: current.id,
        statusId: current.statusId,
        statusName: current.status?.name ?? null,
        poNumber: current.poNumber ?? null,
        rateReal: current.rateReal ?? null,
        netProfitReal: current.netProfitReal ?? null,
        updateStatus: current.updateStatus ?? null,
      },
      after: {
        id: updated.id,
        statusId: updated.statusId,
        statusName: updated.status?.name ?? null,
        poNumber: updated.poNumber ?? null,
        rateReal: updated.rateReal ?? null,
        netProfitReal: updated.netProfitReal ?? null,
        updateStatus: updated.updateStatus ?? null,
      },

      // comentario en espanol: meta MINIMA (sin payload interno del DTO)
      meta: {
        changedFields,
        statusWillChange,
        fromStatus: current.status?.name ?? null,
        toStatus: updated.status?.name ?? null,
        actorRole,
        targetUserId: current.userId, // dueño de la orden (para auditoría)
      },
    });

    // notificación al dueño (solo si cambia el status)
    if (statusWillChange) {
      await this.notificationsService.createAndSend({
        recipientId: updated.estimate.idUser,
        actorId: actor.id,
        message: `The status of your order #${updated.number} has changed to "${updated.status.name}".`,
        actionUrl: `/orders/${updated.id}`,
        actionLabel: 'Open order',
        dedupeKey: `order:${updated.id}:status:${updated.statusId}:${updated.updateStatus.toISOString()}`,
      });
    }

    if (statusWillChange && updated.status.name === 'Preparing for pickup') {
      await this.prisma.$transaction((tx) =>
        this.installationWorkflow.markOrderReady(tx, updated.idEst),
      );
      const installation = await this.prisma.installationJob.findUnique({
        where: { estimateId: updated.idEst },
        select: { id: true, status: true },
      });
      if (
        installation?.status ===
        InstallationJobStatus.INSTALLATION_PAYMENT_PENDING
      ) {
        await this.notificationsService.createAndSend({
          recipientId: updated.estimate.idUser,
          actorId: actor.id,
          message: updated.estimate.paymentPlanSnapshot
            ? `The next project installment is due for Order #${updated.number}.`
            : `Installation balance is due for Order #${updated.number}.`,
          actionUrl: `/orders/${updated.id}`,
          actionLabel: 'Open payment',
          dedupeKey: `order:${updated.id}:installation-balance-due`,
        });
      }
    }

    return updated;
  }

  async createExtraCharge(
    orderId: number,
    dto: CreateOrderExtraChargeDto,
    actor: AuthUser,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          status: true,
          user: true,
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
                      type: {
                        in: [
                          PaymentType.INSTALLATION_DEPOSIT,
                          PaymentType.INSTALLATION,
                        ],
                      },
                      OR: [{ status: PaymentStatus.PAID }, { netPaidBaseAmount: { not: null } }],
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!order) {
        throw new NotFoundException(`Order with ID #${orderId} not found.`);
      }

      const installation = order.estimate.installationJob;
      if (
        !installation ||
        installation.status === InstallationJobStatus.CANCELED
      ) {
        throw new BadRequestException(
          'Installation extra charges require an installation order.',
        );
      }
      if (!canCreateInstallationExtraCharge(order.status.name)) {
        throw new BadRequestException(
          'Extra charges can be created after the installation order is Delivered.',
        );
      }

      const quote = installation.quotes[0];
      if (!quote) {
        throw new BadRequestException(
          'An approved installation quote is required.',
        );
      }
      const installationPaid = installation.payments.reduce(
        (sum, payment) => sum.add(paidPrincipal(payment)).add(decimalAmount(payment.refundCreditAmount)),
        new Decimal(0),
      );
      if (!order.estimate.paymentPlanSnapshot && installationPaid.lt(discountedInstallationTotal(order.estimate, installation))) {
        throw new BadRequestException(
          'Installation must be paid before creating extra charges.',
        );
      }

      const taxParameter = await tx.globalParameter.findUnique({
        where: { key: GlobalParameterKey.SALES_TAX },
      });
      const taxRate = order.user.isTaxExempt
        ? new Decimal(0)
        : new Decimal(taxParameter?.value.toString() ?? 0);
      if (taxRate.lt(0) || taxRate.gt(1)) {
        throw new BadRequestException(
          'Sales tax must be stored as a decimal fraction between 0 and 1.',
        );
      }

      const lines = dto.lines.map((line, index) => {
        const quantity = new Decimal(line.quantity);
        const unitPrice = new Decimal(line.unitPrice);
        const subtotal = quantity
          .mul(unitPrice)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const taxable = line.taxable === true;
        const taxAmount = taxable
          ? subtotal.mul(taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : new Decimal(0);
        return {
          description: line.description.trim(),
          quantity: new Prisma.Decimal(quantity.toFixed(4)),
          unitPrice: new Prisma.Decimal(unitPrice.toFixed(2)),
          taxable,
          subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
          taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
          total: new Prisma.Decimal(subtotal.add(taxAmount).toFixed(2)),
          sortOrder: index,
        };
      });
      if (lines.some((line) => !line.description)) {
        throw new BadRequestException(
          'Every extra-charge line requires a description.',
        );
      }

      const subtotal = lines.reduce(
        (sum, line) => sum.add(line.subtotal.toString()),
        new Decimal(0),
      );
      const taxAmount = lines.reduce(
        (sum, line) => sum.add(line.taxAmount.toString()),
        new Decimal(0),
      );
      const latest = await tx.orderExtraCharge.findFirst({
        where: { orderId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      return tx.orderExtraCharge.create({
        data: {
          orderId,
          sequence: (latest?.sequence ?? 0) + 1,
          status: OrderExtraChargeStatus.PENDING_CUSTOMER_APPROVAL,
          subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
          taxRateSnapshot: new Prisma.Decimal(taxRate.toFixed(4)),
          taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
          total: new Prisma.Decimal(subtotal.add(taxAmount).toFixed(2)),
          notes: dto.notes?.trim() || null,
          createdById: actor.id,
          submittedAt: new Date(),
          lines: { create: lines },
        },
        include: {
          lines: { orderBy: { sortOrder: 'asc' } },
          payment: true,
        },
      });
    });

    await this.logsService.log({
      action: 'CREATE',
      entityType: 'OrderExtraCharge',
      entityId: created.id,
      userId: actor.id,
      message: `Extra charge #${created.sequence} created for Order #${orderId}.`,
      after: {
        orderId,
        sequence: created.sequence,
        total: created.total.toString(),
        status: created.status,
      },
    });
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { userId: true, number: true },
    });
    await this.notificationsService.createAndSend({
      recipientId: order.userId,
      actorId: actor.id,
      message: `Extra charge #${created.sequence} for Order #${order.number} needs your approval.`,
      actionUrl: `/orders/${orderId}`,
      actionLabel: 'Review charge',
      dedupeKey: `order:${orderId}:extra:${created.id}:approval:owner`,
    });
    return created;
  }

  async respondExtraCharge(
    chargeId: number,
    dto: RespondOrderExtraChargeDto,
    actor: AuthUser,
  ) {
    const charge = await this.prisma.orderExtraCharge.findUnique({
      where: { id: chargeId },
      include: { order: true },
    });
    if (!charge || charge.order.userId !== actor.id) {
      throw new NotFoundException('Extra charge not found.');
    }
    if (charge.status !== OrderExtraChargeStatus.PENDING_CUSTOMER_APPROVAL) {
      throw new BadRequestException(
        'This extra charge is not awaiting customer approval.',
      );
    }

    const approved = dto.decision === OrderExtraChargeDecision.APPROVE;
    const updated = await this.prisma.orderExtraCharge.update({
      where: { id: chargeId },
      data: {
        status: approved
          ? OrderExtraChargeStatus.PAYMENT_DUE
          : OrderExtraChargeStatus.REJECTED,
        decisionComment: dto.comment?.trim() || null,
        respondedById: actor.id,
        respondedAt: new Date(),
      },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        payment: true,
      },
    });

    await this.logsService.log({
      action: 'UPDATE',
      entityType: 'OrderExtraCharge',
      entityId: updated.id,
      userId: actor.id,
      message: `Extra charge #${updated.sequence} ${approved ? 'approved' : 'rejected'}.`,
      before: { status: charge.status },
      after: { status: updated.status },
    });
    const responseMessage = `The project owner ${approved ? 'approved' : 'rejected'} extra charge #${updated.sequence} for Order #${charge.order.number}.`;
    const dedupeKey = `order:${charge.orderId}:extra:${updated.id}:response:${updated.status}`;
    await this.notificationsService.createAndSend({
      recipientId: charge.createdById,
      actorId: actor.id,
      message: responseMessage,
      actionUrl: `/orders/${charge.orderId}`,
      actionLabel: 'Review response',
      dedupeKey: `${dedupeKey}:creator`,
    });
    await this.notificationsService.createAndSendToRoles(
      ['admin'],
      {
        message: responseMessage,
        actionUrl: `/orders/${charge.orderId}`,
        actionLabel: 'Review response',
        dedupeKey: `${dedupeKey}:admin`,
      },
      { excludeUserIds: [charge.createdById, actor.id] },
    );
    return updated;
  }

  async findAllForUser(user: AuthUser) {
    const roleName = getRoleName(user);

    if (roleName === 'admin' || roleName === 'operator') {
      return this.findAll();
    }

    const orders = await this.prisma.order.findMany({
      where: { userId: user.id },
      include: orderListInclude,
      orderBy: { date: 'desc' },
    });
    return orders.map((order) => ({
      ...withOrderListSummary(order),
      deliveries: order.deliveries.map((delivery) => ({
        ...delivery,
        internalReason: null,
      })),
    }));
  }

  async findOneForUser(id: number, user: AuthUser) {
    const roleName = getRoleName(user);

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: orderDetailsInclude,
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);

    const paymentSchedule = await getPaymentSchedule(this.prisma, order.idEst);
    const estimate = { ...order.estimate, manualDiscountSummary: calculateEstimateDiscount(order.estimate) };
    const earnings = buildDealerEarningsReport(order.estimate, order);
    if (roleName === 'admin' || roleName === 'operator') return { ...order, ...earnings, estimate, paymentSchedule };

    if (order.userId !== user.id) {
      throw new NotFoundException(`Order with ID #${id} not found.`);
    }

    return {
      ...order,
      ...earnings,
      estimate,
      paymentSchedule,
      deliveries: order.deliveries.map((delivery) => ({
        ...delivery,
        internalReason: null,
      })),
    };
  }
}

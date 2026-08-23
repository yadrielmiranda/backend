import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BrandingType,
  DeliveryStatus,
  DeliveryType,
  GlobalParameterKey,
  InstallationJobStatus,
  OrderFulfillmentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';
import { calculateDeliveryPricing } from './delivery-pricing';
import {
  GoogleRoutesService,
  type DeliveryRouteAddress,
} from './google-routes.service';
import { GoogleAddressValidationService } from './google-address-validation.service';
import { CreateDeliveryDto, ScheduleDeliveryDto } from './dto/delivery.dto';
import { deliveryToPickupBlockReason } from './delivery-selection-policy';

const deliveryInclude = {
  payment: true,
} satisfies Prisma.OrderDeliveryInclude;

const orderForDeliveryInclude = {
  status: true,
  user: { include: { role: true } },
  estimate: {
    include: {
      installationJob: {
        include: {
          quotes: {
            where: { status: 'APPROVED' as const },
            orderBy: { version: 'desc' as const },
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
              status: PaymentStatus.PAID,
            },
          },
        },
      },
    },
  },
  deliveries: {
    orderBy: { sequence: 'asc' as const },
    include: deliveryInclude,
  },
} satisfies Prisma.OrderInclude;

type DeliveryOrder = Prisma.OrderGetPayload<{
  include: typeof orderForDeliveryInclude;
}>;

const isStaff = (role: string | null | undefined) =>
  role === 'admin' || role === 'operator';

const hasActiveInstallation = (order: DeliveryOrder) =>
  Boolean(
    order.estimate.installationJob &&
      order.estimate.installationJob.status !== InstallationJobStatus.CANCELED,
  );

const activeDelivery = (status: DeliveryStatus) =>
  status !== DeliveryStatus.CANCELED;

const deliveryLabel = (type: DeliveryType) => {
  if (type === DeliveryType.INSTALLATION_OVERRIDE) {
    return 'Delivery with installation';
  }
  if (type === DeliveryType.PRE_DELIVERY) return 'Separate pre-delivery';
  if (type === DeliveryType.REDELIVERY) return 'Redelivery';
  return 'Delivery';
};

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routes: GoogleRoutesService,
    private readonly addressValidation: GoogleAddressValidationService,
    private readonly notifications: NotificationsService,
    private readonly logs: LogsService,
  ) {}

  private async getOrder(orderId: number, actor: AuthUser) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderForDeliveryInclude,
    });
    const role = getRoleName(actor);
    if (!order || (!isStaff(role) && order.userId !== actor.id)) {
      throw new NotFoundException(`Order with ID #${orderId} not found.`);
    }
    return order;
  }

  private resolveDestination(
    order: DeliveryOrder,
    dto: CreateDeliveryDto,
  ): DeliveryRouteAddress {
    const supplied = [dto.street, dto.city, dto.state, dto.postalCode];
    const hasAnySupplied = supplied.some((value) => value !== undefined);
    if (hasAnySupplied && supplied.some((value) => !value?.trim())) {
      throw new BadRequestException(
        'Street, city, state and ZIP code are all required for a delivery address.',
      );
    }

    if (hasAnySupplied) {
      const destination = {
        street: dto.street!.trim(),
        city: dto.city!.trim(),
        state: dto.state!.trim().toUpperCase(),
        postalCode: dto.postalCode!.trim(),
      };
      this.assertUsAddressFormat(destination);
      return destination;
    }

    const dealerCustomer = order.user.role.name === 'dealer';
    const destination = dealerCustomer
      ? {
          street: order.estimate.customerStreet,
          city: order.estimate.customerCity,
          state: order.estimate.customerState,
          postalCode: order.estimate.customerPostalCode,
        }
      : {
          street: order.user.street,
          city: order.user.city,
          state: order.user.state,
          postalCode: order.user.postalCode,
        };

    if (
      !destination.street ||
      !destination.city ||
      !destination.state ||
      !destination.postalCode
    ) {
      throw new BadRequestException(
        'Complete the delivery address before calculating delivery.',
      );
    }
    const resolved = {
      street: destination.street,
      city: destination.city,
      state: destination.state.toUpperCase(),
      postalCode: destination.postalCode,
    };
    this.assertUsAddressFormat(resolved);
    return resolved;
  }

  private assertUsAddressFormat(address: DeliveryRouteAddress) {
    if (!/^[A-Z]{2}$/.test(address.state)) {
      throw new BadRequestException(
        'Enter the two-letter state code, for example FL.',
      );
    }
    if (!/^\d{5}(?:-\d{4})?$/.test(address.postalCode)) {
      throw new BadRequestException('Enter a valid 5-digit ZIP code or ZIP+4.');
    }
  }

  private assertInstallationPaid(order: DeliveryOrder) {
    const installation = order.estimate.installationJob;
    if (
      !installation ||
      installation.status === InstallationJobStatus.CANCELED
    ) {
      return;
    }
    const quote = installation.quotes[0];
    if (!quote) {
      throw new BadRequestException(
        'An approved installation quote is required before delivery.',
      );
    }
    const paid = installation.payments.reduce(
      (sum, payment) => sum.add(payment.baseAmount.toString()),
      new Decimal(0),
    );
    if (paid.lt(quote.total.toString())) {
      throw new BadRequestException(
        'Installation must be paid before the materials can be delivered.',
      );
    }
  }

  async selectPickup(orderId: number, actor: AuthUser) {
    const order = await this.getOrder(orderId, actor);
    if (order.status.name !== 'Ready to pick up') {
      throw new BadRequestException(
        'Pickup can be selected only when the order is Ready to pick up.',
      );
    }
    if (hasActiveInstallation(order)) {
      throw new BadRequestException(
        'This order already includes delivery with its installation.',
      );
    }
    const activeDeliveries = order.deliveries.filter((delivery) =>
      activeDelivery(delivery.status),
    );
    if (activeDeliveries.length > 1) {
      throw new BadRequestException(
        'Pickup cannot replace multiple active delivery charges. Contact an administrator.',
      );
    }

    const delivery = activeDeliveries[0] ?? null;
    if (delivery) {
      const blockReason = deliveryToPickupBlockReason(delivery);
      if (blockReason === 'ACTIVE_CHECKOUT') {
        throw new BadRequestException(
          'Cancel the active delivery checkout before changing this order to pickup.',
        );
      }
      if (blockReason === 'ALREADY_PAID') {
        throw new BadRequestException(
          'A paid delivery cannot be changed to pickup automatically. Contact an administrator about a refund or adjustment.',
        );
      }
      if (blockReason === 'NOT_STANDARD') {
        throw new BadRequestException(
          'Only an unpaid standard delivery can be replaced by customer pickup.',
        );
      }
      if (blockReason === 'NOT_AWAITING_PAYMENT') {
        throw new BadRequestException(
          'Only a delivery awaiting payment can be replaced by customer pickup.',
        );
      }
    }

    const selectedAt = new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        let canceledDelivery = null;
        if (delivery) {
          const currentDelivery = await tx.orderDelivery.findUnique({
            where: { id: delivery.id },
            include: deliveryInclude,
          });
          if (!currentDelivery) {
            throw new BadRequestException(
              'Delivery no longer exists. Refresh the order and try again.',
            );
          }
          const currentBlockReason =
            deliveryToPickupBlockReason(currentDelivery);
          if (currentBlockReason === 'ACTIVE_CHECKOUT') {
            throw new BadRequestException(
              'Cancel the active delivery checkout before changing this order to pickup.',
            );
          }
          if (currentBlockReason !== null) {
            throw new BadRequestException(
              'Delivery changed while pickup was being selected. Refresh the order and try again.',
            );
          }

          const canceled = await tx.orderDelivery.updateMany({
            where: {
              id: delivery.id,
              status: DeliveryStatus.PAYMENT_DUE,
            },
            data: {
              status: DeliveryStatus.CANCELED,
              canceledAt: selectedAt,
            },
          });
          if (canceled.count !== 1) {
            throw new BadRequestException(
              'Delivery changed while pickup was being selected. Refresh the order and try again.',
            );
          }
          canceledDelivery = await tx.orderDelivery.findUnique({
            where: { id: delivery.id },
            include: deliveryInclude,
          });
        }

        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: {
            fulfillmentMethod: OrderFulfillmentMethod.CUSTOMER_PICKUP,
            fulfillmentSelectedAt: selectedAt,
            pickupCompletedAt: null,
          },
          include: { status: true },
        });
        return { order: updatedOrder, canceledDelivery };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    await this.logs.log({
      action: 'UPDATE',
      entityType: 'Order',
      entityId: orderId,
      userId: actor.id,
      message: `Customer pickup selected for Order #${order.number}.`,
      before: {
        fulfillmentMethod: order.fulfillmentMethod,
        deliveryId: delivery?.id ?? null,
        deliveryStatus: delivery?.status ?? null,
      },
      after: {
        fulfillmentMethod: result.order.fulfillmentMethod,
        deliveryId: result.canceledDelivery?.id ?? null,
        deliveryStatus: result.canceledDelivery?.status ?? null,
      },
    });
    if (!isStaff(getRoleName(actor))) {
      await this.notifications.createAndSendToRoles(['admin'], {
        message: `Customer pickup was selected for Order #${order.number}.`,
        actionUrl: `/orders/${order.id}`,
        actionLabel: 'Open order',
        dedupeKey: `order:${order.id}:pickup:selected:admin`,
      });
    }
    return result;
  }

  async completePickup(orderId: number, actor: AuthUser) {
    const order = await this.getOrder(orderId, actor);
    if (
      order.status.name !== 'Ready to pick up' ||
      order.fulfillmentMethod !== OrderFulfillmentMethod.CUSTOMER_PICKUP
    ) {
      throw new BadRequestException(
        'This order is not ready for customer-pickup completion.',
      );
    }
    const pickedUp = await this.prisma.orderStatus.findUnique({
      where: { name: 'Picked up' },
    });
    if (!pickedUp) throw new Error('Order status "Picked up" is not seeded.');

    const completedAt = new Date();
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        statusId: pickedUp.id,
        updateStatus: completedAt,
        pickupCompletedAt: completedAt,
      },
      include: { status: true },
    });
    await this.logs.log({
      action: 'UPDATE',
      entityType: 'Order',
      entityId: orderId,
      userId: actor.id,
      message: `Customer pickup completed for Order #${order.number}.`,
      before: { status: order.status.name },
      after: { status: updated.status.name },
    });
    await this.notifications.createAndSend({
      recipientId: order.userId,
      message: `Pickup was completed for Order #${order.number}.`,
      actionUrl: `/orders/${order.id}`,
      actionLabel: 'Open order',
      dedupeKey: `order:${order.id}:pickup:completed:owner`,
    });
    return updated;
  }

  async createDelivery(
    orderId: number,
    dto: CreateDeliveryDto,
    actor: AuthUser,
  ) {
    const order = await this.getOrder(orderId, actor);
    const role = getRoleName(actor);
    const type = dto.type ?? DeliveryType.STANDARD;
    const installationActive = hasActiveInstallation(order);
    const reason = dto.internalReason?.trim() || null;

    if (type !== DeliveryType.STANDARD && role !== 'admin') {
      throw new ForbiddenException(
        'Only an administrator can create special delivery charges.',
      );
    }
    if (type !== DeliveryType.STANDARD && !reason) {
      throw new BadRequestException(
        'An internal reason is required for a special delivery charge.',
      );
    }

    if (type === DeliveryType.STANDARD) {
      if (order.status.name !== 'Ready to pick up') {
        throw new BadRequestException(
          'Delivery can be selected only when the order is Ready to pick up.',
        );
      }
      if (installationActive) {
        throw new BadRequestException(
          'This order includes delivery with installation. Use an admin override or a separate pre-delivery instead.',
        );
      }
    } else if (
      type === DeliveryType.INSTALLATION_OVERRIDE ||
      type === DeliveryType.PRE_DELIVERY
    ) {
      if (!installationActive || order.status.name !== 'Ready to pick up') {
        throw new BadRequestException(
          'This delivery type requires an active installation order that is Ready to pick up.',
        );
      }
    } else if (
      !['Delivered', 'Installation in progress', 'Installed'].includes(
        order.status.name,
      )
    ) {
      throw new BadRequestException(
        'Redelivery can be charged only after the original delivery.',
      );
    }

    if (
      type !== DeliveryType.REDELIVERY &&
      order.deliveries.some(
        (delivery) =>
          delivery.type !== DeliveryType.REDELIVERY &&
          activeDelivery(delivery.status),
      )
    ) {
      throw new BadRequestException(
        'An active pickup/delivery choice already exists for this order.',
      );
    }

    const requestedDestination = this.resolveDestination(order, dto);
    const [company, parameters] = await Promise.all([
      this.prisma.branding.findFirst({
        where: { type: BrandingType.COMPANY, isActive: true },
      }),
      this.prisma.globalParameter.findMany({
        where: {
          key: {
            in: [
              GlobalParameterKey.DELIVERY_BASE_PRICE,
              GlobalParameterKey.DELIVERY_INCLUDED_MILES,
              GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE,
              GlobalParameterKey.SALES_TAX,
            ],
          },
        },
      }),
    ]);
    if (
      !company?.street ||
      !company.city ||
      !company.state ||
      !company.postalCode
    ) {
      throw new BadRequestException(
        'Complete the active Company Branding address before calculating delivery.',
      );
    }
    const origin: DeliveryRouteAddress = {
      street: company.street,
      city: company.city,
      state: company.state.toUpperCase(),
      postalCode: company.postalCode,
    };
    const byKey = new Map(parameters.map((item) => [item.key, item.value]));
    const basePrice = byKey.get(GlobalParameterKey.DELIVERY_BASE_PRICE);
    const includedMiles = byKey.get(GlobalParameterKey.DELIVERY_INCLUDED_MILES);
    const additionalMilePrice = byKey.get(
      GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE,
    );
    if (!basePrice || !includedMiles || !additionalMilePrice) {
      throw new BadRequestException(
        'Configure all three delivery pricing parameters before calculating delivery.',
      );
    }

    const taxable = role === 'admin' && dto.taxable === true;
    const taxRate =
      taxable && !order.user.isTaxExempt
        ? (byKey.get(GlobalParameterKey.SALES_TAX)?.toString() ?? '0')
        : '0';
    const destination =
      await this.addressValidation.validateDeliveryAddress(
        requestedDestination,
      );
    const route = await this.routes.calculateDrivingRoute(origin, destination);
    let pricing;
    try {
      pricing = calculateDeliveryPricing({
        distanceMeters: route.distanceMeters,
        basePrice: basePrice.toString(),
        includedMiles: includedMiles.toString(),
        additionalMilePrice: additionalMilePrice.toString(),
        tollAmount: 0,
        taxRate,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid delivery pricing.',
      );
    }

    const delivery = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.orderDelivery.findFirst({
        where: { orderId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const created = await tx.orderDelivery.create({
        data: {
          orderId,
          sequence: (latest?.sequence ?? 0) + 1,
          type,
          status: DeliveryStatus.PAYMENT_DUE,
          vehicleProfile: 'PICKUP',
          routeProvider: route.provider,
          originStreet: origin.street,
          originCity: origin.city,
          originState: origin.state,
          originPostalCode: origin.postalCode,
          destinationStreet: destination.street,
          destinationCity: destination.city,
          destinationState: destination.state,
          destinationPostalCode: destination.postalCode,
          distanceMeters: route.distanceMeters,
          roadMiles: new Prisma.Decimal(pricing.roadMiles.toFixed(2)),
          basePriceSnapshot: new Prisma.Decimal(pricing.basePrice.toFixed(2)),
          includedMilesSnapshot: new Prisma.Decimal(
            pricing.includedMiles.toFixed(2),
          ),
          additionalMilePriceSnapshot: new Prisma.Decimal(
            pricing.additionalMilePrice.toFixed(2),
          ),
          additionalMiles: new Prisma.Decimal(
            pricing.additionalMiles.toFixed(2),
          ),
          tollAmount: new Prisma.Decimal(pricing.tollAmount.toFixed(2)),
          taxable,
          taxRateSnapshot: new Prisma.Decimal(pricing.taxRate.toFixed(4)),
          subtotal: new Prisma.Decimal(pricing.subtotal.toFixed(2)),
          taxAmount: new Prisma.Decimal(pricing.taxAmount.toFixed(2)),
          total: new Prisma.Decimal(pricing.total.toFixed(2)),
          internalReason: reason,
          createdById: actor.id,
        },
        include: deliveryInclude,
      });

      if (type !== DeliveryType.REDELIVERY) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            fulfillmentMethod:
              type === DeliveryType.INSTALLATION_OVERRIDE
                ? OrderFulfillmentMethod.INSTALLATION_DELIVERY
                : OrderFulfillmentMethod.COMPANY_DELIVERY,
            fulfillmentSelectedAt: new Date(),
            pickupCompletedAt: null,
          },
        });
      }
      return created;
    });

    await this.logs.log({
      action: 'CREATE',
      entityType: 'OrderDelivery',
      entityId: delivery.id,
      userId: actor.id,
      message: `${deliveryLabel(type)} #${delivery.sequence} created for Order #${order.number}.`,
      after: {
        orderId,
        type,
        status: delivery.status,
        roadMiles: delivery.roadMiles.toString(),
        additionalMiles: delivery.additionalMiles.toString(),
        total: delivery.total.toString(),
      },
    });

    if (isStaff(role)) {
      await this.notifications.createAndSend({
        recipientId: order.userId,
        message: `${deliveryLabel(type)} for Order #${order.number} is ready for payment.`,
        actionUrl: `/orders/${order.id}`,
        actionLabel: 'Open payment',
        dedupeKey: `order:${order.id}:delivery:${delivery.id}:payment:owner`,
      });
    } else {
      await this.notifications.createAndSendToRoles(['admin'], {
        message: `Delivery was selected for Order #${order.number}.`,
        actionUrl: `/orders/${order.id}`,
        actionLabel: 'Open order',
        dedupeKey: `order:${order.id}:delivery:${delivery.id}:selected:admin`,
      });
    }
    return delivery;
  }

  async scheduleDelivery(
    deliveryId: number,
    dto: ScheduleDeliveryDto,
    actor: AuthUser,
  ) {
    const delivery = await this.prisma.orderDelivery.findUnique({
      where: { id: deliveryId },
      include: { order: true, payment: true },
    });
    if (!delivery) throw new NotFoundException('Delivery not found.');
    if (delivery.type === DeliveryType.INSTALLATION_OVERRIDE) {
      throw new BadRequestException(
        'This delivery uses the accepted installation appointment and is not scheduled separately.',
      );
    }
    if (
      (delivery.status !== DeliveryStatus.READY_TO_SCHEDULE &&
        delivery.status !== DeliveryStatus.SCHEDULED) ||
      delivery.payment?.status !== PaymentStatus.PAID
    ) {
      throw new BadRequestException(
        'Delivery must be paid before it can be scheduled.',
      );
    }
    const scheduledFor = new Date(dto.scheduledFor);
    if (scheduledFor.getTime() < Date.now() - 5 * 60 * 1000) {
      throw new BadRequestException('Delivery date cannot be in the past.');
    }

    const updated = await this.prisma.orderDelivery.update({
      where: { id: deliveryId },
      data: { status: DeliveryStatus.SCHEDULED, scheduledFor },
      include: deliveryInclude,
    });
    await this.logs.log({
      action: 'UPDATE',
      entityType: 'OrderDelivery',
      entityId: deliveryId,
      userId: actor.id,
      message: `Delivery #${delivery.sequence} scheduled for Order #${delivery.order.number}.`,
      before: { status: delivery.status, scheduledFor: delivery.scheduledFor },
      after: { status: updated.status, scheduledFor: updated.scheduledFor },
    });
    await this.notifications.createAndSend({
      recipientId: delivery.order.userId,
      message: `${deliveryLabel(delivery.type)} for Order #${delivery.order.number} was scheduled.`,
      actionUrl: `/orders/${delivery.orderId}`,
      actionLabel: 'View schedule',
      dedupeKey: `order:${delivery.orderId}:delivery:${delivery.id}:scheduled:${updated.updatedAt.toISOString()}`,
    });
    return updated;
  }

  async completeDelivery(deliveryId: number, actor: AuthUser) {
    const delivery = await this.prisma.orderDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        payment: true,
        order: { include: orderForDeliveryInclude },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery not found.');
    if (delivery.type === DeliveryType.INSTALLATION_OVERRIDE) {
      throw new BadRequestException(
        'Delivery with installation is completed automatically when installation starts.',
      );
    }
    if (
      (delivery.status !== DeliveryStatus.READY_TO_SCHEDULE &&
        delivery.status !== DeliveryStatus.SCHEDULED) ||
      delivery.payment?.status !== PaymentStatus.PAID
    ) {
      throw new BadRequestException(
        'Only a paid delivery can be marked completed.',
      );
    }

    const order = delivery.order;
    const shouldFulfillOrder = order.status.name === 'Ready to pick up';
    if (shouldFulfillOrder) this.assertInstallationPaid(order);
    const deliveredStatus = shouldFulfillOrder
      ? await this.prisma.orderStatus.findUnique({
          where: { name: 'Delivered' },
        })
      : null;
    if (shouldFulfillOrder && !deliveredStatus) {
      throw new Error('Order status "Delivered" is not seeded.');
    }

    const completedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const completed = await tx.orderDelivery.update({
        where: { id: deliveryId },
        data: { status: DeliveryStatus.COMPLETED, completedAt },
        include: deliveryInclude,
      });
      if (shouldFulfillOrder) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            statusId: deliveredStatus!.id,
            updateStatus: completedAt,
            fulfillmentMethod: OrderFulfillmentMethod.COMPANY_DELIVERY,
          },
        });
      }
      return completed;
    });

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'OrderDelivery',
      entityId: deliveryId,
      userId: actor.id,
      message: `${deliveryLabel(delivery.type)} #${delivery.sequence} completed for Order #${order.number}.`,
      before: { status: delivery.status },
      after: { status: updated.status, completedAt },
    });
    await this.notifications.createAndSend({
      recipientId: order.userId,
      message: `${deliveryLabel(delivery.type)} was completed for Order #${order.number}.`,
      actionUrl: `/orders/${order.id}`,
      actionLabel: 'Open order',
      dedupeKey: `order:${order.id}:delivery:${delivery.id}:completed:owner`,
    });
    return updated;
  }
}

// @/orders/orders.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  GlobalParameterKey,
  InstallationJobStatus,
  Order,
  OrderExtraChargeStatus,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from "@prisma/client";
import Decimal from "decimal.js";
import { PrismaService } from "@/prisma/prisma.service";
import { UpdateOrderDto } from "./dto/update-order.dto";
import { NotificationsService } from "@/notifications/notifications.service";
import { AuthUser } from "@/auth/types/auth-user.type";
import { getRoleName } from "@/auth/utils/get-role-name";
import { LogsService } from "@/logs/logs.service";
import { InstallationWorkflowService } from "@/installation/installation-workflow.service";
import {
  CreateOrderExtraChargeDto,
  OrderExtraChargeDecision,
  RespondOrderExtraChargeDto,
} from "./dto/order-extra-charge.dto";
import {
  canCreateInstallationExtraCharge,
  nextManualOrderStatus,
} from "@/installation/installation-flow-policy";

const orderDetailsInclude = {
  estimate: true,
  status: true,
  user: true,
  extraCharges: {
    orderBy: { sequence: "asc" as const },
    include: {
      lines: { orderBy: { sortOrder: "asc" as const } },
      payment: true,
    },
  },
} satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private logsService: LogsService,
    private installationWorkflow: InstallationWorkflowService,
  ) {}

  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      include: orderDetailsInclude,
      orderBy: { date: "desc" },
    });
  }

  async findOne(id: number): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: orderDetailsInclude,
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);
    return order;
  }

  async findAllStatuses(): Promise<OrderStatus[]> {
    return this.prisma.orderStatus.findMany({ orderBy: { id: "asc" } });
  }

  async update(
    id: number,
    updateOrderDto: UpdateOrderDto,
    actor: AuthUser,
  ): Promise<Order> {
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
                  where: { status: "APPROVED" },
                  orderBy: { version: "desc" },
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
        user: true,
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

    const normalizedPo =
      updateOrderDto.poNumber === undefined
        ? undefined
        : String(updateOrderDto.poNumber || "").trim() || null;

    const normalizedRateReal =
      updateOrderDto.rateReal === undefined
        ? undefined
        : updateOrderDto.rateReal === null
          ? null
          : new Prisma.Decimal(updateOrderDto.rateReal);

    const statusWillChange =
      updateOrderDto.statusId !== undefined &&
      updateOrderDto.statusId !== current.statusId;

    // comentario en espanol: las transiciones operativas son secuenciales.
    if (statusWillChange && nextStatus) {
      if (["Installation in progress", "Installed"].includes(nextStatus.name)) {
        throw new BadRequestException(
          "Start and complete installation from the Installation workflow.",
      );
      }

      const expected = nextManualOrderStatus(current.status.name);
      if (expected !== nextStatus.name) {
        throw new BadRequestException(
          `Order status must advance from "${current.status.name}" to ${expected ? `"${expected}"` : "its installation workflow"}.`,
        );
      }

      const installation = current.estimate.installationJob;
      if (
        nextStatus.name === "Delivered" &&
        installation &&
        installation.status !== InstallationJobStatus.CANCELED
      ) {
        const quote = installation.quotes[0];
        if (!quote) {
          throw new BadRequestException(
            "An approved installation quote is required before delivery.",
          );
        }
        const paidInstallation = installation.payments.reduce(
          (sum, payment) => sum.add(payment.baseAmount.toString()),
          new Decimal(0),
        );
        if (paidInstallation.lt(quote.total.toString())) {
          throw new BadRequestException(
            "Installation must be paid before an installation order can be marked Delivered.",
          );
        }
      }

      const requiresPO = [
        "In production",
        "Ready to pick up",
        "Delivered",
      ].includes(nextStatus.name);

      if (requiresPO) {
        const finalPo =
          normalizedPo !== undefined
            ? normalizedPo
            : (current.poNumber ?? null);

        if (!finalPo) {
          throw new BadRequestException(
            `PO Number is required before moving the order to "${nextStatus.name}".`,
          );
        }
      }
    }

    const finalRateReal =
      normalizedRateReal !== undefined ? normalizedRateReal : current.rateReal;

    const nextNetProfitReal =
      finalRateReal === null || finalRateReal === undefined
        ? null
        : current.price.minus(finalRateReal);

    const data: Prisma.OrderUpdateInput = {
      ...(updateOrderDto.statusId !== undefined && {
        statusId: updateOrderDto.statusId,
      }),
      ...(normalizedPo !== undefined && { poNumber: normalizedPo }),
      ...(normalizedRateReal !== undefined && { rateReal: normalizedRateReal }),
      netProfitReal: nextNetProfitReal,
      ...(statusWillChange && { updateStatus: new Date() }),
    };

    const updated = await this.prisma.order.update({
      where: { id },
      data,
      include: {
        status: true,
        estimate: { include: { user: true } },
        user: true,
        extraCharges: {
          orderBy: { sequence: "asc" },
          include: {
            lines: { orderBy: { sortOrder: "asc" } },
            payment: true,
          },
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
    if (statusWillChange) changedFields.push("statusId");
    if (normalizedPo !== undefined && normalizedPo !== current.poNumber)
      changedFields.push("poNumber");
    if (normalizedRateReal !== undefined) {
      const curr = current.rateReal?.toString() ?? null;
      const next = normalizedRateReal?.toString() ?? null;
      if (curr !== next) changedFields.push("rateReal");
    }

    await this.logsService.log({
      action: "UPDATE",
      entityType: "Order",
      entityId: updated.id,
      userId: actor.id, // ✅ quien hizo el cambio
      message: statusWillChange
        ? `Order status changed: "${current.status?.name ?? ""}" -> "${updated.status?.name ?? ""}"`
        : "Order updated",

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
        message: `The status of your order #${updated.number} has changed to "${updated.status.name}".`,
      });
    }

    if (statusWillChange && updated.status.name === "Ready to pick up") {
      await this.prisma.$transaction((tx) =>
        this.installationWorkflow.markOrderReady(tx, updated.idEst),
      );
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
                    where: { status: "APPROVED" },
                    orderBy: { version: "desc" },
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
          "Installation extra charges require an installation order.",
        );
      }
      if (!canCreateInstallationExtraCharge(order.status.name)) {
        throw new BadRequestException(
          "Extra charges can be created after the installation order is Delivered.",
        );
      }

      const quote = installation.quotes[0];
      if (!quote) {
        throw new BadRequestException(
          "An approved installation quote is required.",
        );
      }
      const installationPaid = installation.payments.reduce(
        (sum, payment) => sum.add(payment.baseAmount.toString()),
        new Decimal(0),
      );
      if (installationPaid.lt(quote.total.toString())) {
        throw new BadRequestException(
          "Installation must be paid before creating extra charges.",
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
          "Sales tax must be stored as a decimal fraction between 0 and 1.",
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
          "Every extra-charge line requires a description.",
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
        orderBy: { sequence: "desc" },
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
          lines: { orderBy: { sortOrder: "asc" } },
          payment: true,
        },
      });
    });

    await this.logsService.log({
      action: "CREATE",
      entityType: "OrderExtraCharge",
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
      throw new NotFoundException("Extra charge not found.");
    }
    if (charge.status !== OrderExtraChargeStatus.PENDING_CUSTOMER_APPROVAL) {
      throw new BadRequestException(
        "This extra charge is not awaiting customer approval.",
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
        lines: { orderBy: { sortOrder: "asc" } },
        payment: true,
      },
    });

    await this.logsService.log({
      action: "UPDATE",
      entityType: "OrderExtraCharge",
      entityId: updated.id,
      userId: actor.id,
      message: `Extra charge #${updated.sequence} ${approved ? "approved" : "rejected"}.`,
      before: { status: charge.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async findAllForUser(user: AuthUser) {
    const roleName = getRoleName(user);

    if (roleName === "admin" || roleName === "operator") {
      return this.findAll();
    }

    return this.prisma.order.findMany({
      where: { userId: user.id },
      include: orderDetailsInclude,
      orderBy: { date: "desc" },
    });
  }

  async findOneForUser(id: number, user: AuthUser) {
    const roleName = getRoleName(user);

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: orderDetailsInclude,
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);

    if (roleName === "admin" || roleName === "operator") return order;

    if (order.userId !== user.id) {
      throw new NotFoundException(`Order with ID #${id} not found.`);
    }

    return order;
  }
}

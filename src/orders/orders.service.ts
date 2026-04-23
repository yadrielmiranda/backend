// @/orders/orders.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, Order, OrderStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { UpdateOrderDto } from './dto/update-order.dto';
import { NotificationsService } from '@/notifications/notifications.service';
import { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name';
import { LogsService } from '@/logs/logs.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private logsService: LogsService,
  ) {}

  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      include: { estimate: true, status: true, user: true },
      orderBy: { date: 'desc' },
    });
  }

  async findOne(id: number): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { estimate: true, status: true, user: true },
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);
    return order;
  }

  async findAllStatuses(): Promise<OrderStatus[]> {
    return this.prisma.orderStatus.findMany();
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
        estimate: { include: { user: true } },
        user: true,
      },
    });

    if (!current) throw new NotFoundException(`Order with ID #${id} not found.`);

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
        : String(updateOrderDto.poNumber || '').trim() || null;

    const normalizedRateReal =
      updateOrderDto.rateReal === undefined
        ? undefined
        : updateOrderDto.rateReal === null
          ? null
          : new Prisma.Decimal(updateOrderDto.rateReal);

    const statusWillChange =
      updateOrderDto.statusId !== undefined &&
      updateOrderDto.statusId !== current.statusId;

    // comentario en espanol: PO obligatorio para mover a estados "posteriores"
    if (statusWillChange && nextStatus) {
      const requiresPO = ['In production', 'Ready to pick up', 'Delivered'].includes(
        nextStatus.name,
      );

      if (requiresPO) {
        const finalPo =
          normalizedPo !== undefined ? normalizedPo : current.poNumber ?? null;

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
      ...(updateOrderDto.statusId !== undefined && { statusId: updateOrderDto.statusId }),
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
    if (normalizedPo !== undefined && normalizedPo !== current.poNumber) changedFields.push('poNumber');
    if (normalizedRateReal !== undefined) {
      const curr = current.rateReal?.toString() ?? null;
      const next = normalizedRateReal?.toString() ?? null;
      if (curr !== next) changedFields.push('rateReal');
    }

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
        message: `The status of your order #${updated.number} has changed to "${updated.status.name}".`,
      });
    }

    return updated;
  }

  async findAllForUser(user: AuthUser) {
    const roleName = getRoleName(user);

    if (roleName === 'admin' || roleName === 'operator') {
      return this.findAll();
    }

    return this.prisma.order.findMany({
      where: { userId: user.id },
      include: { estimate: true, status: true, user: true },
      orderBy: { date: 'desc' },
    });
  }

  async findOneForUser(id: number, user: AuthUser) {
    const roleName = getRoleName(user);

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { estimate: true, status: true, user: true },
    });

    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);

    if (roleName === 'admin' || roleName === 'operator') return order;

    if (order.userId !== user.id) {
      throw new NotFoundException(`Order with ID #${id} not found.`);
    }

    return order;
  }
}

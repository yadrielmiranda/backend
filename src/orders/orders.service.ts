import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Order, OrderStatus } from '@prisma/client';
import { UpdateOrderDto } from './dto/update-order.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AuthUser } from 'src/auth/types/auth-user.type';
import { getRoleName } from 'src/auth/utils/get-role-name';

type RoleName = 'admin' | 'operator' | 'client' | 'dealer';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService, // Se inyecta el servicio de notificaciones
  ) { }

  async createOrderFromEstimate(
    estimateId: number,
    userId: number,
  ): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {

      const estimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: { order: true },
      });

      if (!estimate) {
        throw new NotFoundException(
          `Estimate with ID #${estimateId} not found.`,
        );
      }

      if (estimate.order) {
        throw new ConflictException(
          `Estimate with ID #${estimateId} already has an associated order.`,
        );
      }

      // 🔐 VALIDACIÓN CLAVE (AQUÍ)
      if (estimate.idUser !== userId) {
        throw new NotFoundException(
          `Estimate with ID #${estimateId} not found.`,
        );
      }

      const inProductionStatus = await tx.orderStatus.findUnique({
        where: { name: 'In production' },
      });

      if (!inProductionStatus) {
        throw new NotFoundException(
          'Order status "In production" not found. Please run the database seed.',
        );
      }

      const lastOrder = await tx.order.findFirst({
        orderBy: { id: 'desc' },
      });

      const lastOrderId = lastOrder?.id ?? 0;
      const newOrderNumber = `ORD-${lastOrderId + 1001}`;

      const newOrder = await tx.order.create({
        data: {
          number: newOrderNumber,
          units: estimate.units,
          amount: estimate.totalPayable,
          idEst: estimateId,
          statusId: inProductionStatus.id,
          userId: userId,
        },
      });

      await tx.estimate.update({
        where: { id: estimateId },
        data: { active: false },
      });

      return newOrder;
    });
  }


  async findAll(): Promise<Order[]> {
    return this.prisma.order.findMany({
      include: {
        estimate: true,
        status: true,
        user: true,
      },
      orderBy: {
        date: 'desc',
      },
    });
  }

  async findOne(id: number): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        estimate: true,
        status: true,
        user: true,
      },
    });
    if (!order) {
      throw new NotFoundException(`Order with ID #${id} not found.`);
    }
    return order;
  }

  async findAllStatuses(): Promise<OrderStatus[]> {
    return this.prisma.orderStatus.findMany();
  }

  async update(id: number, updateOrderDto: UpdateOrderDto): Promise<Order> {
    const statusExists = await this.prisma.orderStatus.findUnique({
      where: { id: updateOrderDto.statusId },
    });
    if (!statusExists) {
      throw new NotFoundException(`OrderStatus with ID #${updateOrderDto.statusId} not found.`);
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id },
      data: {
        statusId: updateOrderDto.statusId,
      },
      include: {
        status: true,
        estimate: {
          include: {
            user: true,
          },
        },
      },
    });

    await this.notificationsService.createAndSend({
      recipientId: updatedOrder.estimate.idUser,
      message: `The status of your order #${updatedOrder.number} has changed to "${updatedOrder.status.name}".`,
    });

    return this.prisma.order.findUnique({
      where: { id },
      include: { status: true, user: true, estimate: true }
    });
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
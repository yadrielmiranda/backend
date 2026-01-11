import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, Order, OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateOrderDto } from './dto/update-order.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AuthUser } from 'src/auth/types/auth-user.type';
import { getRoleName } from 'src/auth/utils/get-role-name';

type RoleName = 'admin' | 'operator' | 'client' | 'dealer';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async createOrderFromEstimate(
    estimateId: number,
    userId: number,
  ): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({
        where: { id: estimateId },
        include: {
          order: true,
          status: { select: { name: true } }, // ✅ para validar Active
        },
      });

      if (!estimate) {
        throw new NotFoundException(`Estimate with ID #${estimateId} not found.`);
      }

      if (estimate.order) {
        throw new ConflictException(
          `Estimate with ID #${estimateId} already has an associated order.`,
        );
      }

      // 🔐 Solo el dueño puede convertir su estimate en orden
      if (estimate.idUser !== userId) {
        throw new NotFoundException(`Estimate with ID #${estimateId} not found.`);
      }

      // 🔒 Solo se puede ordenar si el estimate está Active
      if (estimate.status?.name !== 'Active') {
        throw new BadRequestException(
          `Estimate with ID #${estimateId} cannot be ordered (status: ${estimate.status?.name ?? 'UNKNOWN'}).`,
        );
      }

      // ✅ Status de la orden (OrderStatus)
      const inProductionStatus = await tx.orderStatus.findUnique({
        where: { name: 'In production' },
        select: { id: true },
      });

      if (!inProductionStatus) {
        throw new NotFoundException(
          'Order status "In production" not found. Please run the database seed.',
        );
      }

      // ✅ Status del estimate (EstimateStatus) => "Ordered"
      const orderedEstimateStatus = await tx.estimateStatus.findUnique({
        where: { name: 'Ordered' },
        select: { id: true },
      });

      if (!orderedEstimateStatus) {
        throw new NotFoundException(
          'Estimate status "Ordered" not found. Please run the database seed.',
        );
      }

      const lastOrder = await tx.order.findFirst({ orderBy: { id: 'desc' } });
      const lastOrderId = lastOrder?.id ?? 0;
      const newOrderNumber = `ORD-${lastOrderId + 1001}`;

      const newOrder = await tx.order.create({
        data: {
          number: newOrderNumber,
          units: estimate.units,

          // amount = total con taxes incluidos (lo que paga el usuario)
          amount: estimate.totalPayable,

          // snapshot financiero (sin taxes)
          price: estimate.priceT,
          rate: estimate.rateT,
          netProfit: estimate.netProfit,

          // reales => NULL al crear
          poNumber: null,
          rateReal: null,
          netProfitReal: null,

          idEst: estimateId,
          statusId: inProductionStatus.id,
          userId,
          // updateStatus se queda con default(now())
        },
      });

      // ✅ Marcar estimate como Ordered (ya ordenado)
      await tx.estimate.update({
        where: { id: estimateId },
        data: { status: { connect: { id: orderedEstimateStatus.id } } },
      });

      return newOrder;
    });
  }

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

  async update(id: number, updateOrderDto: UpdateOrderDto): Promise<Order> {
    const current = await this.prisma.order.findUnique({
      where: { id },
      include: {
        status: true,
        estimate: { include: { user: true } },
        user: true,
      },
    });

    if (!current) throw new NotFoundException(`Order with ID #${id} not found.`);

    if (updateOrderDto.statusId !== undefined) {
      const statusExists = await this.prisma.orderStatus.findUnique({
        where: { id: updateOrderDto.statusId },
      });
      if (!statusExists) {
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

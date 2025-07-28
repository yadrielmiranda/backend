import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Order, OrderStatus } from '@prisma/client';
import { UpdateOrderDto } from './dto/update-order.dto';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) { }

  async createOrderFromEstimate(estimateId: number, userId: number): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      const estimate = await tx.estimate.findUnique({ where: { id: estimateId }, include: { order: true } });
      if (!estimate) throw new NotFoundException(`Estimate with ID #${estimateId} not found.`);
      if (estimate.order) throw new ConflictException(`Estimate with ID #${estimateId} already has an associated order.`);

      const inProductionStatus = await tx.orderStatus.findUnique({ where: { name: 'In production' } });
      if (!inProductionStatus) throw new NotFoundException('Order status "In production" not found. Please run the database seed.');

      const lastOrder = await tx.order.findFirst({ orderBy: { id: 'desc' } });
      const newOrderNumber = `ORD-${(lastOrder?.id || 0) + 1001}`;

      const newOrder = await tx.order.create({
        data: {
          number: newOrderNumber,
          units: estimate.units,
          amount: estimate.total,
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

  // Encontrar todas las órdenes con sus relaciones
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

  // Encontrar una orden por ID
  async findOne(id: number): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        estimate: true,
        status: true,
        user: true,
      },
    });
    if (!order) throw new NotFoundException(`Order with ID #${id} not found.`);
    return order;
  }

  //  Encontrar todos los estados de orden
  async findAllStatuses(): Promise<OrderStatus[]> {
    return this.prisma.orderStatus.findMany();
  }

  //  Actualizar el estado de una orden
  async update(id: number, updateOrderDto: UpdateOrderDto): Promise<Order> {
    // Verificar que el estado al que se quiere cambiar existe
    const statusExists = await this.prisma.orderStatus.findUnique({
      where: { id: updateOrderDto.statusId },
    });
    if (!statusExists) {
      throw new NotFoundException(`OrderStatus with ID #${updateOrderDto.statusId} not found.`);
    }

    return this.prisma.order.update({
      where: { id },
      data: {
        statusId: updateOrderDto.statusId,
      },
      include: {
        status: true, // Devolver el estado actualizado
      }
    });
  }
}
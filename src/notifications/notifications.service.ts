import { Injectable, UnauthorizedException  } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { Notification } from '@prisma/client';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private gateway: NotificationsGateway,
  ) {}

  async createAndSend(data: CreateNotificationDto): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: {
        recipientId: data.recipientId,
        message: data.message,
      },
    });

    this.gateway.sendNotificationToUser(data.recipientId, notification);
    return notification;
  }

  async getNotificationsForUser(userId: number): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
  
  async markAsRead(notificationId: number, userId: number): Promise<Notification> {
    const notification = await this.prisma.notification.findFirst({
        where: { id: notificationId, recipientId: userId }
    });
    if (!notification) {
        throw new Error('Notification not found or access denied');
    }
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  async deleteNotification(notificationId: number, userId: number): Promise<{ message: string }> {
    // Primero, encontramos la notificación para asegurarnos de que pertenece al usuario.
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      // Si no existe, no hacemos nada
      return { message: 'Notification not found.' };
    }

    // ¡Importante! Verificación de seguridad.
    if (notification.recipientId !== userId) {
      throw new UnauthorizedException('You are not authorized to delete this notification.');
    }

    // Si todo está bien, la eliminamos.
    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return { message: 'Notification deleted successfully.' };
  }

    async deleteAllForUser(userId: number): Promise<{ count: number }> {
    // deleteMany es la forma más eficiente de borrar múltiples registros
    const { count } = await this.prisma.notification.deleteMany({
      where: {
        recipientId: userId,
      },
    });
    return { count };
  }
}
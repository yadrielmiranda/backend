import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { Notification, Prisma } from '@prisma/client';
import { CreateNotificationDto } from './dto/create-notification.dto';

type NotificationDb = PrismaService | Prisma.TransactionClient;
type NotificationPayload = Omit<CreateNotificationDto, 'recipientId'>;

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private gateway: NotificationsGateway,
  ) {}

  async createAndSend(
    data: CreateNotificationDto,
    db: NotificationDb = this.prisma,
  ): Promise<Notification> {
    const notificationData = {
      recipientId: data.recipientId,
      message: data.message,
      actionUrl: data.actionUrl,
      actionLabel: data.actionLabel,
      dedupeKey: data.dedupeKey,
    };

    if (data.dedupeKey) {
      const result = await db.notification.createMany({
        data: [notificationData],
        skipDuplicates: true,
      });

      const notification = await db.notification.findFirstOrThrow({
        where: {
          recipientId: data.recipientId,
          dedupeKey: data.dedupeKey,
        },
      });

      if (result.count > 0) {
        this.gateway.sendNotificationToUser(data.recipientId, notification);
      }

      return notification;
    }

    const notification = await db.notification.create({
      data: notificationData,
    });

    this.gateway.sendNotificationToUser(data.recipientId, notification);
    return notification;
  }

  async createAndSendToRoles(
    roleNames: string[],
    data: NotificationPayload,
    options?: {
      excludeUserIds?: number[];
      db?: NotificationDb;
    },
  ): Promise<Notification[]> {
    const db = options?.db ?? this.prisma;
    const excludeUserIds = options?.excludeUserIds ?? [];
    const recipients = await db.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        role: { name: { in: roleNames } },
        ...(excludeUserIds.length > 0 ? { id: { notIn: excludeUserIds } } : {}),
      },
      select: { id: true },
    });

    const notifications: Notification[] = [];
    for (const recipient of recipients) {
      notifications.push(
        await this.createAndSend({ ...data, recipientId: recipient.id }, db),
      );
    }

    return notifications;
  }

  // ✅ Solo devuelve las del usuario (controller pasa req.user.id)
  async getNotificationsForUser(
    userId: number,
    opts?: { take?: number; skip?: number },
  ): Promise<Notification[]> {
    // ✅ límites pro para evitar abuso
    const takeRaw = opts?.take ?? 50;
    const skipRaw = opts?.skip ?? 0;

    const take = Number.isFinite(takeRaw)
      ? Math.min(Math.max(takeRaw, 1), 100)
      : 50;
    const skip = Number.isFinite(skipRaw) ? Math.max(skipRaw, 0) : 0;

    return this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }
  // ✅ Pro: no revelar si existe o no si no es del usuario => NotFound
  async markAsRead(
    notificationId: number,
    userId: number,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notification) {
      throw new NotFoundException(
        `Notification with ID #${notificationId} not found.`,
      );
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  async deleteNotification(
    notificationId: number,
    userId: number,
  ): Promise<{ message: string }> {
    // ✅ Busca SOLO si es del usuario (pro: no leaks)
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, recipientId: userId },
      select: { id: true },
    });

    if (!notification) {
      throw new NotFoundException(
        `Notification with ID #${notificationId} not found.`,
      );
    }

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return { message: 'Notification deleted successfully.' };
  }

  async deleteAllForUser(userId: number): Promise<{ count: number }> {
    const { count } = await this.prisma.notification.deleteMany({
      where: { recipientId: userId },
    });
    return { count };
  }
}

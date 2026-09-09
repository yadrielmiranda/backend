import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { Notification, Prisma } from '@prisma/client';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationSmsService } from './notification-sms.service';
import { NotificationEmailService } from './notification-email.service';

type NotificationDb = PrismaService | Prisma.TransactionClient;
type NotificationInput = CreateNotificationDto & {
  actorId?: number;
  notifyActor?: boolean;
};
type NotificationPayload = Omit<NotificationInput, 'recipientId'>;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly pendingBell = new Map<number, number>();
  private publishingBell = false;

  constructor(
    private prisma: PrismaService,
    private gateway: NotificationsGateway,
    private sms: NotificationSmsService,
    private email: NotificationEmailService,
  ) {}

  async createAndSend(
    data: NotificationInput,
    db: NotificationDb = this.prisma,
  ): Promise<Notification | null> {
    // No avisar al autor de su propia acción, salvo excepciones como la orden creada.
    if (data.actorId === data.recipientId && !data.notifyActor) return null;
    const notificationData = {
      recipientId: data.recipientId,
      message: data.message,
      actionUrl: data.actionUrl,
      actionLabel: data.actionLabel,
      dedupeKey: data.dedupeKey,
    };

    const persist = async (tx: Prisma.TransactionClient) => {
      if (data.dedupeKey) {
        const result = await tx.notification.createMany({
          data: [notificationData],
          skipDuplicates: true,
        });

        const notification = await tx.notification.findFirstOrThrow({
          where: {
            recipientId: data.recipientId,
            dedupeKey: data.dedupeKey,
          },
        });

        if (result.count > 0) {
          await this.sms.enqueue(notification, tx);
          await this.email.enqueue(notification, tx);
        }

        return { notification, created: result.count > 0 };
      }

      const notification = await tx.notification.create({
        data: notificationData,
      });
      await this.sms.enqueue(notification, tx);
      await this.email.enqueue(notification, tx);
      return { notification, created: true };
    };

    // Notificación y envío pendiente se confirman o revierten juntos.
    // Los workers solo ven filas confirmadas; SMTP y Twilio se llaman fuera de la transacción.
    const { notification, created } =
      db === this.prisma
        ? await this.prisma.$transaction(persist)
        : await persist(db);
    if (created) {
      if (db === this.prisma) {
        this.gateway.sendNotificationToUser(data.recipientId, notification);
      } else {
        // Una transacción del llamador todavía puede revertirse. Publicar solo al verla confirmada.
        this.pendingBell.set(notification.id, Date.now() + 60_000);
      }
    }
    return notification;
  }

  @Interval(1_000)
  async publishCommittedNotifications(): Promise<void> {
    if (this.publishingBell || !this.pendingBell.size) return;
    this.publishingBell = true;
    const ids = Array.from(this.pendingBell.keys()).slice(0, 100);
    try {
      // La consulta usa otra transacción y no ve inserciones que aún no estén confirmadas.
      const committed = await this.prisma.notification.findMany({
        where: { id: { in: ids } },
      });
      for (const notification of committed) {
        if (!this.pendingBell.delete(notification.id)) continue;
        this.gateway.sendNotificationToUser(
          notification.recipientId,
          notification,
        );
      }
      for (const id of ids) {
        if ((this.pendingBell.get(id) ?? Infinity) <= Date.now())
          this.pendingBell.delete(id);
      }
    } catch {
      this.logger.warn('Could not publish committed notifications.');
    } finally {
      this.publishingBell = false;
    }
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
      const notification = await this.createAndSend(
        { ...data, recipientId: recipient.id },
        db,
      );
      if (notification) notifications.push(notification);
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

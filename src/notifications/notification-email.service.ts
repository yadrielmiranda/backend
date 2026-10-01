import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  Notification,
  NotificationEmail,
  NotificationEmailStatus,
  Prisma,
} from '@prisma/client';
import { isEmail } from 'class-validator';
import { isIP } from 'node:net';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { PrismaService } from '@/prisma/prisma.service';

const recipientSelect = {
  email: true,
  isActive: true,
  deletedAt: true,
  dealerMode: true,
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;
type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;
type EmailSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  name: string;
  replyTo?: string;
  origin: string;
};

export type EstimateShareEmail = {
  to: string;
  path: string;
  estimateNumber: string | number;
  ownerBrandingName?: string | null;
  ownerEmail?: string | null;
  customerName?: string | null;
  projectName?: string | null;
};

const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_ATTEMPT_MS = 10 * 60 * 1000;
const cleanText = (value: string) => value.replace(/\s+/g, ' ').trim();
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);
  private processing = false;
  private transporter?: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private settings(): EmailSettings | null {
    const get = (name: string) =>
      this.config.get<string>(`NOTIFICATIONS_SMTP_${name}`);
    const host = get('HOST')?.trim();
    const port = Number(get('PORT') ?? 465);
    const secureValue = get('SECURE') ?? 'true';
    const user = get('USER')?.trim();
    // La contraseña conserva sus espacios; no se usa la cuenta de recuperación como respaldo.
    const pass = get('PASS');
    const from = get('FROM_EMAIL')?.trim();
    const replyTo = get('REPLY_TO')?.trim() || undefined;
    if (
      !host ||
      /\s/.test(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !['true', 'false'].includes(secureValue) ||
      !user ||
      !pass ||
      !from ||
      !isEmail(from) ||
      (replyTo && !isEmail(replyTo))
    )
      return null;
    try {
      const url = new URL(this.config.get<string>('PUBLIC_FRONTEND_URL') ?? '');
      const environment = this.config.get<string>('NODE_ENV') ?? 'development';
      const [first, second] = isIP(url.hostname) === 4
        ? url.hostname.split('.').map(Number)
        : [];
      const localHost =
        url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        first === 127 ||
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
      // nest start --watch no define NODE_ENV; HTTP solo sirve para la red local.
      const localDevelopmentHttp =
        url.protocol === 'http:' &&
        ['development', 'test'].includes(environment) &&
        localHost;
      if (
        (url.protocol !== 'https:' && !localDevelopmentHttp) ||
        url.username || url.password
      )
        return null;
      return {
        host,
        port,
        secure: secureValue === 'true',
        user,
        pass,
        from,
        replyTo,
        name: cleanText(get('FROM_NAME') || 'Authentic Evolution Co').slice(
          0,
          100,
        ),
        origin: url.origin,
      };
    } catch {
      return null;
    }
  }

  private isEligible(user: Recipient | null): user is Recipient {
    if (!user?.isActive || user.deletedAt) return false;
    const role = user.role.name.toLowerCase();
    if (
      role !== 'client' &&
      !(role === 'dealer' && (user.dealerMode ?? 'EXTERNAL') === 'EXTERNAL')
    )
      return false;
    // Son avisos operativos del proyecto, no promociones ni una suscripción SMS.
    // Las dos preferencias SMS no controlan el correo de servicio.
    return (
      typeof user.email === 'string' &&
      user.email.trim().length <= 254 &&
      isEmail(user.email.trim())
    );
  }

  assertEstimateShareReady(): void {
    this.estimateShareSettings();
  }

  private estimateShareSettings(): EmailSettings {
    const settings = this.settings();
    if (!settings)
      throw new ServiceUnavailableException(
        'Estimate email is unavailable. Configure the notification email settings and public website URL.',
      );
    return settings;
  }

  async sendEstimateShare(input: EstimateShareEmail): Promise<void> {
    const settings = this.estimateShareSettings();
    const to = input.to.trim().toLowerCase();
    if (to.length > 254 || !isEmail(to))
      throw new BadRequestException('Enter a valid recipient email address.');
    // El servidor entrega solo la ruta; el dominio nunca procede del cliente.
    if (
      !/^\/public\/estimates\/[a-zA-Z0-9_-]+(?:\/agreements\/[a-zA-Z0-9_-]+)?$/.test(
        input.path,
      )
    )
      throw new BadRequestException('Could not create a valid customer estimate link.');
    const link = new URL(input.path, settings.origin).href;
    const number = cleanText(String(input.estimateNumber));
    const ownerName = cleanText(input.ownerBrandingName || settings.name);
    const customerName = cleanText(input.customerName || '');
    const projectName = cleanText(input.projectName || '');
    const includesContract = input.path.includes('/agreements/');
    const document = includesContract ? 'estimate and contract' : 'estimate';
    const title = includesContract ? 'Estimate and contract ready' : 'Estimate ready';
    const subject = Array.from(`Estimate #${number} ready to review`).slice(0, 100).join('');
    const message = [
      customerName ? `Hello ${customerName},` : 'Hello,',
      '',
      `${ownerName} has shared estimate #${number}${projectName ? ` for ${projectName}` : ''} with you.`,
      '',
      `Please review your ${document} using the link below.`,
      '',
      'Thank you.',
    ].join('\n');
    const ownerEmail = input.ownerEmail?.trim();
    const replyTo = ownerEmail && ownerEmail.length <= 254 && isEmail(ownerEmail)
      ? ownerEmail
      : settings.replyTo;
    let info: SMTPTransport.SentMessageInfo;
    try {
      info = await this.transport(settings).sendMail({
        ...this.renderMessage(
          { ...settings, replyTo },
          title,
          subject,
          message,
          includesContract ? 'Review estimate and contract' : 'Review estimate',
          link,
        ),
        to,
      });
    } catch {
      // No exponer destinatarios, credenciales ni respuestas privadas del proveedor.
      throw new ServiceUnavailableException(
        'The estimate email could not be sent. Please try again later.',
      );
    }
    const matchesRecipient = (address: string | { address: string }) =>
      (typeof address === 'string' ? address : address.address)?.toLowerCase() === to;
    if (info?.rejected?.some(matchesRecipient))
      throw new ServiceUnavailableException('The email service rejected the recipient.');
    if (!info?.accepted?.some(matchesRecipient))
      throw new ServiceUnavailableException(
        'The email service did not confirm acceptance of this estimate email.',
      );
  }

  async enqueue(notification: Notification, db: Prisma.TransactionClient) {
    if (!this.settings()) return;
    const user = await db.user.findUnique({
      where: { id: notification.recipientId },
      select: recipientSelect,
    });
    if (!this.isEligible(user)) return;
    // Se guarda dentro de la misma transacción; todavía no se conecta con SMTP.
    await db.notificationEmail.create({
      data: {
        notificationId: notification.id,
        email: user.email.trim().toLowerCase(),
      },
    });
  }

  private heading(notification: Notification) {
    // La clave existente identifica el evento sin cambiar la notificación de la app.
    const [entity, , event, , detail, decision] =
      notification.dedupeKey?.split(':') ?? [];
    const message = cleanText(notification.message);
    let title = 'Project update';
    if (entity === 'order') {
      const titles: Record<string, string> = {
        created: 'Order created',
        status: 'Order status updated',
        'installation-balance-due': 'Installation balance due',
        pickup: 'Pickup completed',
      };
      title = titles[event] ?? 'Order update';
      if (event === 'delivery') {
        const deliveryTitles: Record<string, string> = {
          payment: 'Delivery payment due',
          scheduled: 'Delivery scheduled',
          completed: 'Delivery completed',
        };
        title = deliveryTitles[detail] ?? 'Delivery update';
      } else if (event === 'extra') {
        title =
          detail === 'approval'
            ? 'Extra charge approval requested'
            : 'Extra charge response received';
      }
    } else if (entity === 'installation') {
      const titles: Record<string, string> = {
        'deposit-due': 'Installation deposit due',
        canceled: 'Installation canceled',
        permit: 'Permit status updated',
        started: 'Installation started',
        completed: 'Installation completed',
      };
      title = titles[event] ?? 'Installation update';
      if (event === 'quote') {
        title =
          detail === 'admin' && decision === 'APPROVED'
            ? 'Installation quote ready for review'
            : detail === 'admin' && decision === 'REJECTED'
              ? 'Installation quote returned for revision'
              : 'Installation quote updated';
      } else if (event === 'appointment') {
        title =
          detail === 'proposed'
            ? `${message.startsWith('Remeasurement ') ? 'Remeasurement' : 'Installation'} date proposed`
            : 'Appointment response received';
      }
    } else if (notification.actionLabel === 'Open customer view') {
      title = 'Estimate viewed';
    } else if (notification.actionUrl?.startsWith('/orders/')) {
      title = 'Order update';
    } else if (notification.actionUrl?.startsWith('/installations/')) {
      title = 'Installation update';
    } else if (notification.actionUrl?.startsWith('/estimates/')) {
      title = 'Estimate update';
    }

    // Se toma el número visible del mensaje, nunca el ID interno de la URL.
    const order =
      title !== 'Estimate viewed'
        ? message.match(/\border #([a-z0-9]+(?:-[a-z0-9]+)*)\b/i)?.[1]
        : undefined;
    const estimate = Array.from(
      message.matchAll(/\bestimate #([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi),
    ).at(-1)?.[1];
    const kind = order ? 'Order' : 'Estimate';
    const number = order ?? estimate;
    const reference = number ? `${kind} #${number}` : '';
    const subject = reference
      ? title.startsWith(`${kind} `)
        ? `${reference} ${title.slice(kind.length + 1)}`
        : `${title} - ${reference}`
      : title;
    return { title, subject: Array.from(subject).slice(0, 100).join('') };
  }

  private message(notification: Notification, settings: EmailSettings) {
    let link = `${settings.origin}/`;
    try {
      if (notification.actionUrl?.startsWith('/')) {
        const candidate = new URL(notification.actionUrl, settings.origin);
        if (
          candidate.origin === settings.origin &&
          !candidate.username &&
          !candidate.password
        )
          link = candidate.href;
      }
    } catch {
      /* Si la acción es inválida, se abre el portal. */
    }
    const message = notification.message;
    const label = notification.actionLabel?.trim() || 'Open portal';
    const { title, subject } = this.heading(notification);
    return this.renderMessage(settings, title, subject, message, label, link);
  }

  private renderMessage(
    settings: EmailSettings,
    title: string,
    subject: string,
    message: string,
    label: string,
    link: string,
  ) {
    return {
      from: { name: settings.name, address: settings.from },
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      subject,
      text: `${settings.name}\n\n${title}\n\n${message}\n\n${label}: ${link}`,
      html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="24"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">
      <tr><td style="padding:24px;background:#101322;color:#fff;border-radius:12px 12px 0 0">
        <p style="margin:0 0 8px;font-size:14px">${escapeHtml(settings.name)}</p>
        <h1 style="margin:0;font-size:24px">${escapeHtml(title)}</h1>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 24px;line-height:1.6;white-space:pre-line">${escapeHtml(message)}</p>
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 22px;background:#101322;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">${escapeHtml(label)}</a>
        <p style="margin:24px 0 8px;font-size:13px">You can also open this link:</p>
        <a href="${escapeHtml(link)}" style="font-size:13px;word-break:break-all;color:#111827">${escapeHtml(link)}</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
    };
  }

  private transport(settings: EmailSettings) {
    this.transporter ??= nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: !settings.secure,
      auth: { user: settings.user, pass: settings.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return this.transporter;
  }

  @Interval(10_000)
  async processPending(): Promise<void> {
    if (this.processing) return;
    const settings = this.settings();
    if (!settings) return;
    this.processing = true;
    try {
      const now = new Date();
      // Una caída puede ocurrir después de que SMTP acepte el correo. No repetirlo a ciegas.
      await this.prisma.notificationEmail.updateMany({
        where: {
          status: 'SENDING',
          attemptedAt: { lt: new Date(now.getTime() - STALE_ATTEMPT_MS) },
        },
        data: { status: 'UNKNOWN', errorCode: 'INTERRUPTED_ATTEMPT' },
      });
      await this.prisma.notificationEmail.updateMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(now.getTime() - MAX_AGE_MS) },
        },
        data: { status: 'SKIPPED', errorCode: 'EXPIRED' },
      });
      const pending = await this.prisma.notificationEmail.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { notificationId: 'asc' }],
        take: 20,
      });
      for (const entry of pending) {
        try {
          await this.send(entry, settings);
        } catch {
          // Nunca incluir credenciales, destinatarios o cuerpos en los logs.
          this.logger.error(
            `Could not finish email notification #${entry.notificationId}.`,
          );
        }
      }
    } catch {
      this.logger.error('Could not process the email notification queue.');
    } finally {
      this.processing = false;
    }
  }

  private async finish(
    id: number,
    status: NotificationEmailStatus,
    errorCode: string | null = null,
    messageId?: string,
  ) {
    await this.prisma.notificationEmail.updateMany({
      where: { notificationId: id, status: 'SENDING' },
      data: {
        status,
        errorCode,
        ...(messageId ? { providerMessageId: messageId.slice(0, 320) } : {}),
      },
    });
    if (status === 'FAILED' || status === 'UNKNOWN')
      this.logger.warn(
        `Email notification #${id}: ${status} (${errorCode ?? 'UNKNOWN'}).`,
      );
  }

  private async send(entry: NotificationEmail, settings: EmailSettings) {
    const id = entry.notificationId;
    // Solo un proceso puede reclamar la fila, incluso con varios workers de PM2.
    const claimed = await this.prisma.notificationEmail.updateMany({
      where: {
        notificationId: id,
        status: 'PENDING',
        attempts: entry.attempts,
        nextAttemptAt: { lte: new Date() },
      },
      data: {
        status: 'SENDING',
        attemptedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return;
    const notification = await this.prisma.notification.findUnique({
      where: { id },
      include: { recipient: { select: recipientSelect } },
    });
    const user = notification?.recipient ?? null;
    if (
      !notification ||
      !this.isEligible(user) ||
      user.email.trim().toLowerCase() !== entry.email
    ) {
      await this.finish(id, 'SKIPPED', 'RECIPIENT_CHANGED');
      return;
    }
    const transporter = this.transport(settings);
    let info: SMTPTransport.SentMessageInfo;
    try {
      info = await transporter.sendMail({
        ...this.message(notification, settings),
        to: entry.email,
      });
    } catch (error) {
      const code = Number((error as { responseCode?: number })?.responseCode);
      // Reintentar únicamente un rechazo SMTP temporal explícito; un timeout es ambiguo.
      if (code >= 400 && code < 500 && entry.attempts + 1 < MAX_ATTEMPTS) {
        await this.prisma.notificationEmail.updateMany({
          where: { notificationId: id, status: 'SENDING' },
          data: {
            status: 'PENDING',
            errorCode: `SMTP_${code}`,
            nextAttemptAt: new Date(Date.now() + 60_000 * (entry.attempts + 1)),
          },
        });
      } else {
        const rejected = Number.isInteger(code) && code >= 400 && code < 600;
        await this.finish(
          id,
          rejected ? 'FAILED' : 'UNKNOWN',
          rejected ? `SMTP_${code}` : 'SMTP_CONNECTION_ERROR',
        );
      }
      return;
    }
    const accepted = info?.accepted?.some(
      (address) =>
        (typeof address === 'string'
          ? address
          : address.address
        )?.toLowerCase() === entry.email,
    );
    // ACCEPTED confirma recepción por SMTP, no entrega en la bandeja del destinatario.
    await this.finish(
      id,
      accepted ? 'ACCEPTED' : 'UNKNOWN',
      accepted ? null : 'INVALID_SMTP_RESPONSE',
      info?.messageId,
    );
  }
}

import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrandingType } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '@/prisma/prisma.service';

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const host = this.config.get<string>('SMTP_HOST');
    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    const secure = this.config.get<string>('SMTP_SECURE') === 'true';
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    if (!host || !user || !pass) {
      this.logger.warn(
        'SMTP configuration is incomplete. Email sending will fail until SMTP env variables are configured.',
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
  }

  private async getCompanyName() {
    try {
      const branding = await this.prisma.branding.findFirst({
        where: { type: BrandingType.COMPANY, isActive: true },
        select: { name: true },
      });

      if (branding?.name?.trim()) return branding.name.trim();
    } catch (error) {
      this.logger.warn('Could not load company branding for email.', error);
    }

    return this.config.get<string>('SMTP_FROM_NAME')?.trim() || 'Company';
  }

  private getFrom(companyName: string) {
    const fromEmail = this.config.get<string>('SMTP_FROM_EMAIL');

    if (!fromEmail) {
      throw new InternalServerErrorException(
        'SMTP_FROM_EMAIL is not configured.',
      );
    }

    return `"${companyName.replaceAll('"', '')}" <${fromEmail}>`;
  }

  async sendPasswordResetEmail(params: {
    to: string;
    resetLink: string;
    expiresInMinutes: number;
  }) {
    const companyName = await this.getCompanyName();
    const safeCompanyName = escapeHtml(companyName);
    const subject = 'Reset your password';

    const text = [
      `You requested a password reset for your ${companyName} account.`,
      '',
      `Open this link to set a new password:`,
      params.resetLink,
      '',
      `This link will expire in ${params.expiresInMinutes} minutes.`,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; background: #f6f7fb; padding: 24px;">
        <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; border: 1px solid #e5e7eb;">
          <div style="background: linear-gradient(135deg, #070b1a, #4a0b0f); padding: 28px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Reset your password</h1>
            <p style="color: #cbd5e1; margin: 8px 0 0;">${safeCompanyName}</p>
          </div>

          <div style="padding: 28px;">
            <p style="color: #111827; font-size: 16px; margin-top: 0;">
              We received a request to reset the password for your account.
            </p>

            <p style="color: #374151; font-size: 14px;">
              Click the button below to create a new password. This link will expire in
              <strong>${params.expiresInMinutes} minutes</strong>.
            </p>

            <div style="margin: 28px 0;">
              <a href="${params.resetLink}"
                 style="display: inline-block; background: #ef0000; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 10px; font-weight: 700;">
                Reset Password
              </a>
            </div>

            <p style="color: #6b7280; font-size: 13px;">
              If the button does not work, copy and paste this link into your browser:
            </p>

            <p style="word-break: break-all; color: #374151; font-size: 13px;">
              ${params.resetLink}
            </p>

            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />

            <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
              If you did not request this password reset, you can safely ignore this email.
            </p>
          </div>
        </div>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from: this.getFrom(companyName),
        to: params.to,
        subject,
        text,
        html,
      });
    } catch (error) {
      this.logger.error('Failed to send password reset email', error);
      throw new InternalServerErrorException(
        'Could not send password reset email.',
      );
    }
  }
}

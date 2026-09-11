import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { buildSmsProgram } from './sms-program';
import { UpdateSmsConsentDto } from './dto/update-sms-consent.dto';

@Injectable()
export class SmsConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async getProgram() {
    const company = await this.prisma.branding.findFirst({
      where: { type: 'COMPANY', isActive: true },
      select: { name: true, email: true, phone: true },
    });
    return buildSmsProgram(company);
  }

  async getPreferences(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, isActive: true, deletedAt: true, smsConsent: true },
    });
    if (!user?.isActive || user.deletedAt) {
      throw new UnauthorizedException('This user account is inactive.');
    }
    const block = await this.prisma.smsPhoneBlock.findUnique({
      where: { phone: user.phone },
    });
    const consent = user.smsConsent;
    const samePhone = consent?.phone === user.phone;
    return {
      // Cambiar el texto del programa no invalida ni reescribe elecciones existentes.
      enabled: Boolean(consent?.enabled && samePhone && !consent.revokedAt && !block),
      promotionsEnabled: Boolean(consent?.promotionsEnabled && samePhone && !consent.promotionsRevokedAt && !block),
      phone: user.phone,
      consentedAt: samePhone ? consent.consentedAt : null,
      revokedAt: consent?.revokedAt ?? null,
      promotionsConsentedAt: samePhone ? consent.promotionsConsentedAt : null,
      promotionsRevokedAt: consent?.promotionsRevokedAt ?? null,
      blockedBySms: Boolean(block),
      program: await this.getProgram(),
    };
  }

  async updatePreferences(userId: number, dto: UpdateSmsConsentDto) {
    if (typeof dto.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean.');
    }
    if (dto.promotionsEnabled !== undefined && typeof dto.promotionsEnabled !== 'boolean') {
      throw new BadRequestException('promotionsEnabled must be a boolean.');
    }
    const program = await this.getProgram();
    const enabled = dto.enabled;

    await this.prisma.$transaction(async (tx) => {
      // Coordina las dos preferencias con cambios de teléfono y bajas simultáneas.
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { phone: true, isActive: true, deletedAt: true, smsConsent: true },
      });
      if (!user?.isActive || user.deletedAt) {
        throw new UnauthorizedException('This user account is inactive.');
      }
      const previous = user.smsConsent;
      const samePhone = previous?.phone === user.phone;
      const wasEnabled = Boolean(previous?.enabled && samePhone && !previous.revokedAt);
      const wasPromotionsEnabled = Boolean(previous?.promotionsEnabled && samePhone && !previous.promotionsRevokedAt);
      const promotionsEnabled = dto.promotionsEnabled === undefined
        ? wasPromotionsEnabled
        : dto.promotionsEnabled === true;
      const serviceChanged = enabled !== wasEnabled;
      const promotionsChanged = promotionsEnabled !== wasPromotionsEnabled;
      // Un guardado sin cambios no vuelve a fechar ni a aceptar condiciones antiguas.
      if (!serviceChanged && !promotionsChanged) return;

      const hasNewOptIn = (serviceChanged && enabled) || (promotionsChanged && promotionsEnabled);
      if (hasNewOptIn) {
        if (dto.phone !== user.phone || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(user.phone)) {
          throw new ConflictException('Your phone number changed or is invalid. Reload your SMS preferences and confirm the correct number.');
        }
        if (dto.version !== program.version) {
          throw new ConflictException('The SMS terms changed. Reload and review them before subscribing.');
        }
        const block = await tx.smsPhoneBlock.findUnique({ where: { phone: user.phone } });
        if (block) {
          throw new ConflictException('SMS is blocked after a STOP request. Reply START to the same sending number, then enable SMS here.');
        }
      }

      const now = new Date();
      const consentText = JSON.stringify({ source: 'PROFILE', channel: 'SMS', program });
      const phone = hasNewOptIn ? user.phone : previous?.phone ?? user.phone;
      const data = {
        phone,
        enabled,
        promotionsEnabled,
        ...(serviceChanged ? enabled ? {
          consentVersion: program.version, consentText, consentedAt: now, revokedAt: null,
        } : { revokedAt: now } : {}),
        ...(promotionsChanged ? promotionsEnabled ? {
          promotionsConsentVersion: program.version,
          promotionsConsentText: consentText,
          promotionsConsentedAt: now,
          promotionsRevokedAt: null,
        } : { promotionsRevokedAt: now } : {}),
      };
      await tx.smsConsent.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      if (serviceChanged) {
        await tx.smsConsentEvent.create({
          data: {
            userId, phone, action: enabled ? 'OPT_IN' : 'OPT_OUT', category: 'SERVICE',
            consentVersion: enabled ? program.version : previous?.consentVersion,
            consentText: enabled ? consentText : previous?.consentText,
            createdAt: now,
          },
        });
      }
      if (promotionsChanged) {
        await tx.smsConsentEvent.create({
          data: {
            userId, phone, action: promotionsEnabled ? 'OPT_IN' : 'OPT_OUT', category: 'PROMOTIONAL',
            consentVersion: promotionsEnabled ? program.version : previous?.promotionsConsentVersion,
            consentText: promotionsEnabled ? consentText : previous?.promotionsConsentText,
            createdAt: now,
          },
        });
      }
    });
    return this.getPreferences(userId);
  }

  async recordProviderChoice(phone: string, messageSid: string | null, action: 'STOP' | 'START') {
    // El SID único hace que los reintentos de Twilio sean idempotentes.
    try {
      await this.prisma.$transaction(async (tx) => {
        if (messageSid && await tx.smsConsentEvent.findUnique({ where: { providerMessageSid: messageSid } })) return;
        const users = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM User WHERE phone = ${phone} FOR UPDATE`;
        const userId = users[0]?.id ?? null;
        const now = new Date();
        await tx.smsConsentEvent.create({
          data: { userId, phone, action: action === 'STOP' ? 'PROVIDER_STOP' : 'PROVIDER_START', category: 'ALL', providerMessageSid: messageSid, createdAt: now },
        });

        if (action === 'STOP') {
          await tx.smsPhoneBlock.upsert({ where: { phone }, create: { phone, createdAt: now }, update: { createdAt: now } });
          await tx.smsConsent.updateMany({
            where: { phone, enabled: true },
            data: { enabled: false, revokedAt: now },
          });
          await tx.smsConsent.updateMany({
            where: { phone, promotionsEnabled: true },
            data: { promotionsEnabled: false, promotionsRevokedAt: now },
          });
        } else {
          // START quita el bloqueo del proveedor; cada categoría se activa en Profile.
          await tx.smsPhoneBlock.deleteMany({ where: { phone } });
        }
      });
    } catch (error: unknown) {
      if (messageSid && error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const receipt = await this.prisma.smsConsentEvent.findUnique({ where: { providerMessageSid: messageSid } });
        if (receipt) return;
      }
      throw error;
    }
  }
}

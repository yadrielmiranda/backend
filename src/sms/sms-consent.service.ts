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
    return {
      enabled: Boolean(consent?.enabled && consent.phone === user.phone && !block),
      phone: user.phone,
      consentedAt: consent?.phone === user.phone ? consent.consentedAt : null,
      revokedAt: consent?.revokedAt ?? null,
      blockedBySms: Boolean(block),
      program: await this.getProgram(),
    };
  }

  async updatePreferences(userId: number, dto: UpdateSmsConsentDto) {
    if (typeof dto.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean.');
    }
    const program = await this.getProgram();
    const enabled = dto.enabled;

    await this.prisma.$transaction(async (tx) => {
      // Coordina la aceptación con cambios de teléfono y bajas simultáneas.
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { phone: true, isActive: true, deletedAt: true, smsConsent: true },
      });
      if (!user?.isActive || user.deletedAt) {
        throw new UnauthorizedException('This user account is inactive.');
      }
      const previous = user.smsConsent;
      const now = new Date();

      if (!enabled) {
        if (!previous?.enabled) return;
        await tx.smsConsent.update({
          where: { userId },
          data: { enabled: false, revokedAt: now },
        });
        await tx.smsConsentEvent.create({
          data: {
            userId, phone: previous.phone, action: 'OPT_OUT',
            consentVersion: previous.consentVersion,
            consentText: previous.consentText, createdAt: now,
          },
        });
        return;
      }

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
      if (previous?.enabled && previous.phone === user.phone && previous.consentVersion === program.version) return;

      // Conserva la copia exacta del texto y las condiciones mostradas.
      const consentText = JSON.stringify(program);
      const data = {
        phone: user.phone, enabled: true,
        consentVersion: program.version, consentText,
        consentedAt: now, revokedAt: null,
      };
      await tx.smsConsent.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      await tx.smsConsentEvent.create({
        data: { userId, phone: user.phone, action: 'OPT_IN', consentVersion: program.version, consentText, createdAt: now },
      });
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
          data: { userId, phone, action: action === 'STOP' ? 'PROVIDER_STOP' : 'PROVIDER_START', providerMessageSid: messageSid, createdAt: now },
        });

        if (action === 'STOP') {
          await tx.smsPhoneBlock.upsert({ where: { phone }, create: { phone, createdAt: now }, update: { createdAt: now } });
          await tx.smsConsent.updateMany({
            where: { phone, enabled: true },
            data: { enabled: false, revokedAt: now },
          });
        } else {
          // START quita el bloqueo del proveedor; la suscripción se confirma en Profile.
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

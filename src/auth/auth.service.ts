// @/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { UsersService } from '@/users/users.service';
import { RegisterUserDto } from './dto/register-user.dto';
import * as bcrypt from 'bcrypt';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { addDays } from 'date-fns';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { LogsService } from '@/logs/logs.service';
import { MailService } from '@/mail/mail.service';
import { SmsConsentService } from '@/sms/sms-consent.service';
import { pickProfileFields } from './dto/self-service-fields';
import { assertTokenPurpose, SessionTokenPayload } from './access-session';
import { lockCurrentPlatformTerms, requireCurrentAcceptance, savePlatformTermsAcceptance } from '@/platform-terms/platform-terms.policy';

type JwtRolePayload = string | undefined;

type RefreshPayload = SessionTokenPayload;

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private prisma: PrismaService,
    private jwtService: JwtService,
    private logs: LogsService,
    private mail: MailService,
    private smsConsent: SmsConsentService,
  ) { }

  private accessTtl = process.env.JWT_ACCESS_TTL || '15m';
  private refreshTtl = process.env.JWT_REFRESH_TTL || '30d';
  private bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
  private refreshSessionDays = parseInt(
    process.env.REFRESH_SESSION_TTL_DAYS ?? '30',
    10,
  );

  private idleMinutes = parseInt(process.env.SESSION_IDLE_MINUTES ?? '0', 10);

  private passwordResetMinutes = parseInt(
    process.env.PASSWORD_RESET_EXPIRES_MINUTES ?? '30',
    10,
  );

  private hashResetToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private getPublicFrontendUrl() {
    const publicFrontendUrl = process.env.PUBLIC_FRONTEND_URL;

    if (!publicFrontendUrl) {
      throw new InternalServerErrorException(
        'PUBLIC_FRONTEND_URL is not configured.',
      );
    }

    return publicFrontendUrl.replace(/\/$/, '');
  }

  private buildResetPasswordUrl(token: string) {
    return `${this.getPublicFrontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  }

  // =====================================================
  // ✅ Helpers logs: inicio / fin de sesión
  // Nota: entityId en EventLog es INT NOT NULL.
  // Para sesiones (sid es UUID string), usamos entityId=0 y guardamos sid en meta.sessionId.
  // Además, lo incluimos en message para verlo rápido en la tabla.
  // =====================================================
  private SESSION_ENTITY_ID = 0;

  private async logSessionLogin(params: {
    userId: number;
    sessionId: string;
    ip?: string;
    userAgent?: string;
    source: string;
  }) {
    await this.logs.log({
      action: 'LOGIN',
      entityType: 'Session',
      entityId: this.SESSION_ENTITY_ID, // ✅ NO null
      userId: params.userId,
      message: `Session started (sid: ${params.sessionId})`,
      meta: {
        source: params.source,
        sessionId: params.sessionId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
  }

  private async logSessionLogout(params: {
    userId?: number | null;
    sessionId?: string | null;
    reason:
    | 'USER_LOGOUT'
    | 'IDLE_TIMEOUT'
    | 'REFRESH_INVALID'
    | 'PASSWORD_CHANGED'
    | 'SESSION_EXPIRED'
    | 'SESSION_REVOKED';
    source: string;
  }) {
    const sid = params.sessionId ?? null;

    await this.logs.log({
      action: 'LOGOUT',
      entityType: 'Session',
      entityId: this.SESSION_ENTITY_ID, // ✅ NO null
      userId: params.userId ?? null,
      message: sid ? `Session ended (sid: ${sid})` : 'Session ended',
      meta: {
        source: params.source,
        sessionId: sid,
        reason: params.reason,
      },
    });
  }

  async validateAndSignIn(
    identifier: string,
    pass: string,
  ): Promise<{ access_token: string }> {
    const user = await this.validateUser(identifier, pass);
    const sessionId = this.newSessionId();
    const refreshToken = await this.signRefreshToken(user.id, sessionId, user.passwordUpdatedAt);
    await this.createSession({ sessionId, userId: user.id, refreshToken });
    const access_token = await this.signAccessToken(user, sessionId);
    return { access_token };
  }

  async registerUser(registerUserDto: RegisterUserDto) {
    const { password, serviceConsent, promotionsConsent, consentVersion } = registerUserDto;
    const userData = pickProfileFields(registerUserDto);
    // También se valida aquí para no depender exclusivamente del formulario o del DTO.
    if (serviceConsent !== undefined && typeof serviceConsent !== 'boolean') {
      throw new BadRequestException('serviceConsent must be a boolean.');
    }
    if (promotionsConsent !== undefined && typeof promotionsConsent !== 'boolean') {
      throw new BadRequestException('promotionsConsent must be a boolean.');
    }
    const serviceSmsConsent = serviceConsent === true;
    const promotionalConsent = promotionsConsent === true;
    const wantsSms = serviceSmsConsent || promotionalConsent;
    const program = await this.smsConsent.getProgram();
    if (wantsSms && consentVersion !== program.version) {
      throw new ConflictException({
        code: 'CONSENT_VERSION_CHANGED',
        message: 'The messaging terms changed. Review them and select your preferences again.',
      });
    }
    const hashedPassword = await bcrypt.hash(password, this.bcryptRounds);

    const clientRole = await this.prisma.role.findUnique({
      where: { name: 'client' },
      select: { id: true },
    });

    if (!clientRole) {
      throw new InternalServerErrorException(
        "El rol por defecto 'client' no fue encontrado.",
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const terms = await lockCurrentPlatformTerms(tx);
        requireCurrentAcceptance(terms, registerUserDto.platformTermsAccepted, registerUserDto.platformTermsVersionId);
        if (wantsSms) {
          const block = await tx.smsPhoneBlock.findUnique({ where: { phone: userData.phone } });
          if (block) {
            throw new ConflictException('SMS is blocked after a STOP request. Leave both SMS options unchecked to create your account, or reply START to the same sending number before subscribing.');
          }
        }
        const user = await tx.user.create({
          data: {
            ...userData,
            password: hashedPassword,
            isTaxExempt: false,
            role: { connect: { id: clientRole.id } },
          },
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            street: true,
            city: true,
            state: true,
            postalCode: true,
            markupOverride: true,
            isTaxExempt: true,
            idRole: true,
            role: { select: { id: true, name: true, markup: true } },
          },
        });
        const now = new Date();
        if (terms) await savePlatformTermsAcceptance(tx, user.id, terms.id, 'REGISTRATION');
        const consentText = JSON.stringify({
          source: 'REGISTRATION',
          channel: 'SMS',
          serviceConsent: serviceSmsConsent,
          promotionsConsent: promotionalConsent,
          program,
        });
        // Cuenta y autorizaciones se confirman juntas o se revierte toda la operación.
        await tx.registrationConsent.create({
          data: {
            userId: user.id, phone: user.phone, email: user.email,
            serviceSmsAccepted: serviceSmsConsent,
            // Son campos históricos: no se registra una aceptación de email inexistente.
            // El correo operativo ya no depende de estas banderas.
            serviceEmailAccepted: false,
            promotionalSmsAccepted: promotionalConsent,
            promotionalEmailAccepted: false,
            consentVersion: program.version, consentText, createdAt: now,
          },
        });
        await tx.smsConsent.create({
          data: {
            userId: user.id, phone: user.phone, enabled: serviceSmsConsent,
            consentVersion: serviceSmsConsent ? program.version : null,
            consentText: serviceSmsConsent ? consentText : null,
            consentedAt: serviceSmsConsent ? now : null, revokedAt: null,
            promotionsEnabled: promotionalConsent,
            promotionsConsentVersion: promotionalConsent ? program.version : null,
            promotionsConsentText: promotionalConsent ? consentText : null,
            promotionsConsentedAt: promotionalConsent ? now : null,
            promotionsRevokedAt: null,
          },
        });
        // Ninguna casilla marcada significa ninguna alta SMS, no una aceptación implícita.
        for (const category of [
          ...(serviceSmsConsent ? ['SERVICE'] : []),
          ...(promotionalConsent ? ['PROMOTIONAL'] : []),
        ]) {
          await tx.smsConsentEvent.create({
            data: {
              userId: user.id, phone: user.phone, action: 'OPT_IN', category,
              consentVersion: program.version, consentText, createdAt: now,
            },
          });
        }
        return user;
      });
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      if (error?.code === 'P2002') {
        throw new ConflictException('El nombre de usuario o el email ya existen.');
      }
      throw new InternalServerErrorException('No se pudo crear el usuario.');
    }
  }

  async updateProfile(userId: number, data: UpdateProfileDto) {
    return this.usersService.updateUser({
      where: { id: userId },
      data: pickProfileFields(data),
    });
  }

  private buildAccessPayload(user: any, sessionId: string) {
    return {
      sub: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role?.name as JwtRolePayload,
      sid: sessionId,
      tokenType: 'access',
      passwordVersion: new Date(user.passwordUpdatedAt).getTime(),
    };
  }

  async validateUser(identifier: string, pass: string) {
    const user = await this.usersService.findOneByIdentifier(identifier);
    if (!user) throw new UnauthorizedException('Credenciales inválidas.');

    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('This user account is inactive.');
    }

    const ok = await bcrypt.compare(pass, user.password);
    if (!ok) throw new UnauthorizedException('Credenciales inválidas.');

    return user;
  }

  async signAccessToken(user: any, sessionId: string) {
    return this.jwtService.signAsync(this.buildAccessPayload(user, sessionId), {
      expiresIn: this.accessTtl,
    });
  }

  async signRefreshToken(userId: number, sessionId: string, passwordUpdatedAt: Date) {
    return this.jwtService.signAsync(
      { sub: userId, sid: sessionId, tokenType: 'refresh',
        passwordVersion: new Date(passwordUpdatedAt).getTime(), jti: randomUUID() },
      { expiresIn: this.refreshTtl },
    );
  }

  async createSession(params: {
    sessionId: string;
    userId: number;
    refreshToken: string;
    userAgent?: string;
    ip?: string;
  }) {
    const refreshTokenHash = await bcrypt.hash(
      this.hashResetToken(params.refreshToken),
      this.bcryptRounds,
    );

    const expiresAt = addDays(new Date(), this.refreshSessionDays);

    const session = await this.prisma.session.create({
      data: {
        id: params.sessionId,
        userId: params.userId,
        refreshTokenHash,
        expiresAt,
        userAgent: params.userAgent,
        ip: params.ip,
        lastUsedAt: new Date(),
        lastRefreshedAt: new Date(),
      },
    });

    await this.logSessionLogin({
      userId: params.userId,
      sessionId: params.sessionId,
      ip: params.ip,
      userAgent: params.userAgent,
      source: 'AuthService.createSession',
    });

    return session;
  }

  newSessionId() {
    return randomUUID();
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    const genericMessage =
      'If an account exists with that email, a password reset link has been sent.';

    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        isActive: true,
        deletedAt: true,
      },
    });

    // No revelamos si el email existe o no.
    if (!user || !user.email || !user.isActive || user.deletedAt) {
      return { message: genericMessage };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashResetToken(rawToken);

    const expiresAt = new Date(
      Date.now() + this.passwordResetMinutes * 60 * 1000,
    );

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      }),

      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      }),
    ]);

    const resetLink = this.buildResetPasswordUrl(rawToken);

    await this.mail.sendPasswordResetEmail({
      to: user.email,
      resetLink,
      expiresInMinutes: this.passwordResetMinutes,
    });

    return { message: genericMessage };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const token = dto.token.trim();

    if (!token) {
      throw new BadRequestException('Invalid or expired password reset link.');
    }

    const tokenHash = this.hashResetToken(token);

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        user: {
          select: {
            id: true,
            isActive: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!resetToken || !resetToken.user.isActive || resetToken.user.deletedAt) {
      throw new BadRequestException('Invalid or expired password reset link.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, this.bcryptRounds);

    const activeSessions = await this.prisma.session.findMany({
      where: {
        userId: resetToken.userId,
        revokedAt: null,
      },
      select: {
        id: true,
      },
    });

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          password: hashedPassword,
          passwordUpdatedAt: new Date(),
        },
      }),

      this.prisma.passwordResetToken.updateMany({
        where: {
          userId: resetToken.userId,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      }),

      this.prisma.session.updateMany({
        where: {
          userId: resetToken.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      }),
    ]);

    for (const session of activeSessions) {
      await this.logSessionLogout({
        userId: resetToken.userId,
        sessionId: session.id,
        reason: 'PASSWORD_CHANGED',
        source: 'AuthService.resetPassword',
      });
    }

    return { message: 'Password updated successfully. You can now sign in.' };
  }

  async changePasswordSelf(
    userId: number,
    dto: ChangePasswordDto,
    currentRefreshToken?: string,
  ): Promise<{ accessToken?: string; refreshToken?: string; message: string }> {
    const user = await this.usersService.userWithPassword({ id: userId });
    if (!await bcrypt.compare(dto.currentPassword, user.password)) {
      throw new UnauthorizedException('La contraseña actual es incorrecta.');
    }

    // Solo una renovación vigente puede conservar el acceso tras cambiar la clave.
    let currentSession: { ip: string | null; userAgent: string | null } | null = null;
    if (currentRefreshToken) {
      try {
        const payload = await this.jwtService.verifyAsync<RefreshPayload>(currentRefreshToken);
        assertTokenPurpose(payload, 'refresh');
        const session = await this.prisma.session.findUnique({ where: { id: payload.sid } });
        if (payload.sub === userId && session?.userId === userId && !session.revokedAt &&
          session.expiresAt > new Date() && payload.passwordVersion === user.passwordUpdatedAt.getTime() &&
          await bcrypt.compare(this.hashResetToken(currentRefreshToken), session.refreshTokenHash)) {
          currentSession = session;
        }
      } catch {
        // El cambio sigue siendo válido con la contraseña actual; se cerrarán las sesiones.
      }
    }

    await this.usersService.updateUser({ where: { id: userId }, data: { password: dto.newPassword } });
    const sessions = await this.prisma.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    for (const session of sessions) {
      await this.logSessionLogout({ userId, sessionId: session.id, reason: 'PASSWORD_CHANGED',
        source: 'AuthService.changePasswordSelf' });
    }
    if (!currentSession) return { message: 'Contraseña actualizada. Vuelve a iniciar sesión.' };

    const freshUser = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
    if (!freshUser?.isActive || freshUser.deletedAt) throw new UnauthorizedException('This user account is inactive.');
    const sessionId = this.newSessionId();
    const refreshToken = await this.signRefreshToken(userId, sessionId, freshUser.passwordUpdatedAt);
    // Se crea una sesión nueva; nunca se reactiva una sesión revocada.
    await this.createSession({ sessionId, userId, refreshToken,
      ip: currentSession.ip ?? undefined, userAgent: currentSession.userAgent ?? undefined });
    return {
      accessToken: await this.signAccessToken(freshUser, sessionId), refreshToken,
      message: 'Contraseña actualizada exitosamente.',
    };
  }

  async revokeSession(userId: number, sessionId: string): Promise<void> {
    if (!sessionId) throw new UnauthorizedException('Invalid session.');
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    if (result.count) await this.logSessionLogout({ userId, sessionId, reason: 'USER_LOGOUT', source: 'AuthService.revokeSession' });
  }

  async refreshFromToken(refreshToken: string): Promise<{
    accessToken: string;
    newRefreshToken: string;
  }> {
    let payload: RefreshPayload;

    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado.');
    }

    assertTokenPurpose(payload, 'refresh');

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
    });

    if (!session) throw new UnauthorizedException('Sesión no existe.');
    if (session.userId !== payload.sub) throw new UnauthorizedException('Sesión inválida.');
    if (session.revokedAt) throw new UnauthorizedException('Sesión revocada.');
    if (session.expiresAt <= new Date()) throw new UnauthorizedException('Sesión expirada.');

    if (this.idleMinutes > 0) {
      const ms = Date.now() - new Date(session.lastUsedAt).getTime();
      const maxMs = this.idleMinutes * 60 * 1000;
      if (ms > maxMs) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });

        await this.logSessionLogout({
          userId: session.userId,
          sessionId: session.id,
          reason: 'IDLE_TIMEOUT',
          source: 'AuthService.refreshFromToken(idle)',
        });

        throw new UnauthorizedException('Sesión expirada por inactividad.');
      }
    }

    // bcrypt limita la entrada a 72 bytes; el digest incluye el JWT completo.
    const ok = await bcrypt.compare(this.hashResetToken(refreshToken), session.refreshTokenHash);
    if (!ok) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });

      await this.logSessionLogout({
        userId: session.userId,
        sessionId: session.id,
        reason: 'REFRESH_INVALID',
        source: 'AuthService.refreshFromToken(hash-mismatch)',
      });

      throw new UnauthorizedException('Refresh token inválido.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      include: { role: true },
    });
    if (!user) throw new UnauthorizedException('Usuario no existe.');

    if (!user.isActive || user.deletedAt) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });

      await this.logSessionLogout({
        userId: session.userId,
        sessionId: session.id,
        reason: 'SESSION_REVOKED',
        source: 'AuthService.refreshFromToken(user-inactive)',
      });

      throw new UnauthorizedException('This user account is inactive.');
    }

    {
      const pwdUpdatedMs = new Date(user.passwordUpdatedAt).getTime();
      if (payload.passwordVersion !== pwdUpdatedMs) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });

        await this.logSessionLogout({
          userId: session.userId,
          sessionId: session.id,
          reason: 'PASSWORD_CHANGED',
          source: 'AuthService.refreshFromToken(password-updated)',
        });

        throw new UnauthorizedException('Sesión inválida. Vuelve a iniciar sesión.');
      }
    }

    const accessToken = await this.signAccessToken(user, session.id);

    // La credencial de renovación mantiene el vencimiento original de la sesión.
    // SSR no puede persistir las cookies del navegador; cambiarla aquí invalidaría
    // otras pestañas y peticiones simultáneas. Login/cambio de clave emiten una nueva.
    const refreshed = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null,
        expiresAt: { gt: new Date() } },
      data: {
        lastRefreshedAt: new Date(),
      },
    });
    if (refreshed.count !== 1) throw new UnauthorizedException('Session changed. Sign in again.');

    return { accessToken, newRefreshToken: refreshToken };
  }

  async revokeByRefreshToken(
    refreshToken: string,
    opts?: { reason?: 'USER_LOGOUT' | 'SESSION_REVOKED'; source?: string },
  ): Promise<void> {
    const reason = opts?.reason ?? 'USER_LOGOUT';
    const source = opts?.source ?? 'AuthService.revokeByRefreshToken';

    try {
      const payload = await this.jwtService.verifyAsync<RefreshPayload>(refreshToken);
      assertTokenPurpose(payload, 'refresh');

      const session = await this.prisma.session.findUnique({
        where: { id: payload.sid },
        select: { id: true, userId: true, revokedAt: true },
      });

      if (!session || session.userId !== payload.sub) return;

      if (!session.revokedAt) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });

        await this.logSessionLogout({
          userId: session.userId,
          sessionId: session.id,
          reason,
          source,
        });
      }
    } catch {
      return;
    }
  }
}

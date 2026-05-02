// @/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { UsersService } from '@/users/users.service';
import { RegisterUserDto } from './dto/register-user.dto';
import * as bcrypt from 'bcrypt';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { addDays } from 'date-fns';
import { randomUUID } from 'crypto';
import { LogsService } from '@/logs/logs.service';

type JwtRolePayload = string | undefined;

type RefreshPayload = {
  sub: number;
  sid: string;
  iat?: number;
  exp?: number;
};

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private prisma: PrismaService,
    private jwtService: JwtService,
    private logs: LogsService,
  ) { }

  private accessTtl = process.env.JWT_ACCESS_TTL || '15m';
  private refreshTtl = process.env.JWT_REFRESH_TTL || '30d';
  private bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
  private refreshSessionDays = parseInt(
    process.env.REFRESH_SESSION_TTL_DAYS ?? '30',
    10,
  );

  private idleMinutes = parseInt(process.env.SESSION_IDLE_MINUTES ?? '0', 10);

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
    const access_token = await this.signAccessToken(user);
    return { access_token };
  }

  async registerUser(registerUserDto: RegisterUserDto) {
    const { password, ...userData } = registerUserDto;
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
      return await this.prisma.user.create({
        data: {
          ...userData,
          password: hashedPassword,
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
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('El nombre de usuario o el email ya existen.');
      }
      throw new InternalServerErrorException('No se pudo crear el usuario.');
    }
  }

  async updateProfile(userId: number, data: UpdateProfileDto) {
    return this.usersService.updateUser({
      where: { id: userId },
      data,
    });
  }

  private buildAccessPayload(user: any) {
    return {
      sub: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role?.name as JwtRolePayload,
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

  async signAccessToken(user: any) {
    return this.jwtService.signAsync(this.buildAccessPayload(user), {
      expiresIn: this.accessTtl,
    });
  }

  async signRefreshToken(userId: number, sessionId: string) {
    return this.jwtService.signAsync(
      { sub: userId, sid: sessionId },
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
      params.refreshToken,
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

  async changePasswordSelf(
    userId: number,
    dto: ChangePasswordDto,
    currentRefreshToken?: string,
  ): Promise<{ accessToken?: string; refreshToken?: string; message: string }> {
    const user = await this.usersService.userWithPassword({ id: userId });

    const isPasswordMatching = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isPasswordMatching) {
      throw new UnauthorizedException('La contraseña actual es incorrecta.');
    }

    await this.usersService.updateUser({
      where: { id: userId },
      data: { password: dto.newPassword },
    });

    if (!currentRefreshToken) {
      const sessionsToRevoke = await this.prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      for (const s of sessionsToRevoke) {
        await this.logSessionLogout({
          userId,
          sessionId: s.id,
          reason: 'PASSWORD_CHANGED',
          source: 'AuthService.changePasswordSelf(no-refresh)',
        });
      }

      return { message: 'Contraseña actualizada. Vuelve a iniciar sesión.' };
    }

    let payload: RefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(currentRefreshToken);
    } catch {
      const sessionsToRevoke = await this.prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      for (const s of sessionsToRevoke) {
        await this.logSessionLogout({
          userId,
          sessionId: s.id,
          reason: 'PASSWORD_CHANGED',
          source: 'AuthService.changePasswordSelf(bad-refresh)',
        });
      }

      return { message: 'Contraseña actualizada. Vuelve a iniciar sesión.' };
    }

    if (!payload?.sid || payload.sub !== userId) {
      const sessionsToRevoke = await this.prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      for (const s of sessionsToRevoke) {
        await this.logSessionLogout({
          userId,
          sessionId: s.id,
          reason: 'PASSWORD_CHANGED',
          source: 'AuthService.changePasswordSelf(mismatch-refresh)',
        });
      }

      return { message: 'Contraseña actualizada. Vuelve a iniciar sesión.' };
    }

    const currentSid = payload.sid;

    const sessionsToRevoke = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, NOT: { id: currentSid } },
      select: { id: true },
    });

    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, NOT: { id: currentSid } },
      data: { revokedAt: new Date() },
    });

    for (const s of sessionsToRevoke) {
      await this.logSessionLogout({
        userId,
        sessionId: s.id,
        reason: 'PASSWORD_CHANGED',
        source: 'AuthService.changePasswordSelf(revoke-others)',
      });
    }

    const newRefresh = await this.signRefreshToken(userId, currentSid);
    const newHash = await bcrypt.hash(newRefresh, this.bcryptRounds);

    await this.prisma.session.update({
      where: { id: currentSid },
      data: {
        refreshTokenHash: newHash,
        lastUsedAt: new Date(),
        revokedAt: null,
      },
    });

    const freshUser = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!freshUser) throw new UnauthorizedException('Usuario no existe.');

    const newAccess = await this.signAccessToken(freshUser);

    return {
      accessToken: newAccess,
      refreshToken: newRefresh,
      message: 'Contraseña actualizada exitosamente.',
    };
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

    if (!payload?.sub || !payload?.sid) {
      throw new UnauthorizedException('Refresh token inválido.');
    }

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

    const ok = await bcrypt.compare(refreshToken, session.refreshTokenHash);
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

    if (payload.iat) {
      const refreshIatMs = payload.iat * 1000;
      const pwdUpdatedMs = new Date(user.passwordUpdatedAt).getTime();
      if (pwdUpdatedMs > refreshIatMs) {
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

    const accessToken = await this.signAccessToken(user);

    const newRefreshToken = await this.signRefreshToken(user.id, session.id);
    const newHash = await bcrypt.hash(newRefreshToken, this.bcryptRounds);

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: newHash,
        lastRefreshedAt: new Date(),
      },
    });

    return { accessToken, newRefreshToken };
  }

  async revokeByRefreshToken(
    refreshToken: string,
    opts?: { reason?: 'USER_LOGOUT' | 'SESSION_REVOKED'; source?: string },
  ): Promise<void> {
    const reason = opts?.reason ?? 'USER_LOGOUT';
    const source = opts?.source ?? 'AuthService.revokeByRefreshToken';

    try {
      const payload = await this.jwtService.verifyAsync<RefreshPayload>(refreshToken);
      if (!payload?.sid) return;

      const session = await this.prisma.session.findUnique({
        where: { id: payload.sid },
        select: { id: true, userId: true, revokedAt: true },
      });

      if (!session) return;

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

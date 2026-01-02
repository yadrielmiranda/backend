import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';
import { REFRESH_COOKIE } from 'src/auth/auth.tokens';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from 'src/auth/public.decorator';

type RefreshPayload = {
  sub: number;
  sid: string;
  iat?: number;
  exp?: number;
};

@Injectable()
export class SessionTouchGuard implements CanActivate {
  private idleMinutes = parseInt(process.env.SESSION_IDLE_MINUTES ?? '0', 10);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // ✅ No tocar nada en rutas públicas
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    // ✅ Si el idle está desactivado, no hacemos nada
    if (this.idleMinutes <= 0) return true;

    const req = ctx.switchToHttp().getRequest<any>();
    const refresh = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    // ✅ Si no hay refresh cookie, dejamos pasar (JwtAuthGuard se encargará)
    if (!refresh) return true;

    // ✅ Importante: NO queremos “revivir” la sesión con cualquier GET automático.
    // Solo tocamos (update lastUsedAt) en mutaciones (POST/PUT/PATCH/DELETE).
    const method = String(req.method || 'GET').toUpperCase();
    const shouldTouch =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refresh);
    } catch {
      // ✅ Refresh inválido => no bloqueamos aquí; JwtAuthGuard decidirá con access
      return true;
    }

    if (!payload?.sid || !payload?.sub) return true;

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    });

    if (!session) return true;
    if (session.userId !== payload.sub) return true;

    // ✅ Si la sesión está revocada o expirada por días (30d)
    if (session.revokedAt) {
      throw new UnauthorizedException('Session revoked.');
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired.');
    }

    // ✅ Idle real (inactividad)
    const lastUsed = new Date(session.lastUsedAt).getTime();
    const now = Date.now();
    const maxMs = this.idleMinutes * 60 * 1000;

    if (now - lastUsed > maxMs) {
      // ✅ Marca revocada por idle y forzamos 401 para que el frontend abra login modal
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expired due to inactivity.');
    }

    // ✅ Solo tocamos si es una acción real (mutación)
    if (shouldTouch) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return true;
  }
}

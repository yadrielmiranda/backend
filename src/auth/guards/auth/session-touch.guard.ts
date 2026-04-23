import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@/prisma/prisma.service';
import { REFRESH_COOKIE } from '@/auth/auth.tokens';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';

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

    const method = String(req.method || 'GET').toUpperCase();

    /**
     * Detectar path real
     * - originalUrl suele traer algo como "/api/auth/profile"
     */
    const path = String(req.originalUrl || req.url || '');

    /**
     * ✅ Rutas que NO deben contar como "actividad"
     * (no deben actualizar lastUsedAt)
     */
    const EXCLUDED_TOUCH_PATHS = ['/api/auth/profile', '/api/auth/refresh'];

    const isExcludedTouch = EXCLUDED_TOUCH_PATHS.some((p) => path.includes(p));

    /**
     * ✅ Mutaciones SIEMPRE cuentan como actividad (excepto que tú quieras excluir alguna)
     */
    const isMutation =
      method === 'POST' ||
      method === 'PUT' ||
      method === 'PATCH' ||
      method === 'DELETE';

    /**
     * ✅ Touch (actualizar lastUsedAt) si:
     * - es mutación (y no es /auth/refresh), o
     * - es GET pero NO está excluido
     */
    const shouldTouchLastUsedAt =
      (isMutation && !path.includes('/api/auth/refresh')) ||
      (method === 'GET' && !isExcludedTouch);

    /**
     * ✅ Si es refresh, NO tocar lastUsedAt; solo lastRefreshedAt
     */
    const isRefreshEndpoint = path.includes('/api/auth/refresh');

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

    // ✅ Idle real (inactividad) usando lastUsedAt
    const lastUsed = new Date(session.lastUsedAt).getTime();
    const now = Date.now();
    const maxMs = this.idleMinutes * 60 * 1000;

    if (now - lastUsed > maxMs) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session expired due to inactivity.');
    }

    // ✅ Actualizaciones controladas
    if (isRefreshEndpoint) {
      // refresh NO cuenta como actividad: solo marca lastRefreshedAt
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastRefreshedAt: new Date() },
      });
    } else if (shouldTouchLastUsedAt) {
      // GET real o mutación real => cuenta como actividad
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return true;
  }
}

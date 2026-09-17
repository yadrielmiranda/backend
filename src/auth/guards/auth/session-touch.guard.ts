import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@/prisma/prisma.service';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';

@Injectable()
export class SessionTouchGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser; method?: string; originalUrl?: string; url?: string }>();
    // JwtAuthGuard ya validó la sesión; nunca se deduce desde una cookie opcional.
    const actor = req.user;
    if (!actor?.sessionId) throw new UnauthorizedException('Sign in again.');
    const path = String(req.originalUrl || req.url || '');
    if (req.method === 'GET' && path.includes('/api/auth/profile')) return true;
    const result = await this.prisma.session.updateMany({
      where: { id: actor.sessionId, userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { lastUsedAt: new Date() },
    });
    if (result.count !== 1) throw new UnauthorizedException('Session expired or revoked.');
    return true;
  }
}

import { UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { AuthUser, RoleName } from './types/auth-user.type';

export type SessionTokenPayload = {
  sub: number;
  sid: string;
  tokenType: 'access' | 'refresh';
  passwordVersion: number;
  iat?: number;
  exp?: number;
};

export function assertTokenPurpose(payload: SessionTokenPayload, purpose: SessionTokenPayload['tokenType']) {
  if (!payload || payload.tokenType !== purpose || !Number.isSafeInteger(payload.sub) || payload.sub <= 0 ||
    typeof payload.sid !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(payload.sid) ||
    !Number.isSafeInteger(payload.passwordVersion) || payload.passwordVersion <= 0) {
    throw new UnauthorizedException('Invalid session token. Sign in again.');
  }
}

// HTTP y sockets consultan la misma sesión y los permisos vigentes en cada acceso.
export async function validateAccessSession(prisma: PrismaService, payload: SessionTokenPayload): Promise<AuthUser> {
  assertTokenPurpose(payload, 'access');
  if (!Number.isFinite(payload.exp) || payload.exp! * 1000 <= Date.now()) {
    throw new UnauthorizedException('Access token expired.');
  }
  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    include: { user: { select: {
      id: true, username: true, firstName: true, lastName: true, email: true,
      isActive: true, deletedAt: true, passwordUpdatedAt: true,
      role: { select: { name: true } },
    } } },
  });
  const now = Date.now();
  if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt.getTime() <= now) {
    throw new UnauthorizedException('Session expired or revoked. Sign in again.');
  }
  const user = session.user;
  if (!user.isActive || user.deletedAt || user.passwordUpdatedAt.getTime() !== payload.passwordVersion) {
    throw new UnauthorizedException('This session is no longer valid. Sign in again.');
  }
  const idleMinutes = Number(process.env.SESSION_IDLE_MINUTES ?? 0);
  if (idleMinutes > 0 && now - session.lastUsedAt.getTime() > idleMinutes * 60_000) {
    throw new UnauthorizedException('Session expired due to inactivity.');
  }
  const role = user.role.name;
  if (!['admin', 'operator', 'dealer', 'client', 'technician'].includes(role)) {
    throw new UnauthorizedException('Invalid account role.');
  }
  return {
    id: user.id, username: user.username, firstName: user.firstName,
    lastName: user.lastName, email: user.email, role: { name: role as RoleName },
    sessionId: session.id,
  };
}

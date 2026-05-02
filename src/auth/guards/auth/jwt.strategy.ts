// src/auth/guards/auth/jwt.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

import type { AuthUser, RoleName } from '@/auth/types/auth-user.type';

type RolePayload = { name: string } | string | null | undefined;

interface AuthPayload {
  sub: number | string;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: RolePayload;
}

function normalizeRoleName(role: RolePayload): RoleName | undefined {
  const raw = typeof role === 'string' ? role : role?.name;
  if (raw === 'admin' || raw === 'operator' || raw === 'client' || raw === 'dealer') {
    return raw;
  }
  return undefined;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_SECRET_KEY');
    if (!secret) {
      throw new Error('JWT_SECRET_KEY is not set in .env');
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => request?.cookies?.access_token,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: AuthPayload): Promise<AuthUser> {
    const id = typeof payload.sub === 'string' ? Number(payload.sub) : payload.sub;

    const roleName = normalizeRoleName(payload.role);

    const dbUser = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        isActive: true,
        deletedAt: true,
      },
    });

    if (!dbUser || !dbUser.isActive || dbUser.deletedAt) {
      throw new UnauthorizedException('This user account is inactive.');
    }

    return {
      id,
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      role: roleName ? { name: roleName } : undefined,
    };
  }
}

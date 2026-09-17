import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { SessionTokenPayload, validateAccessSession } from '@/auth/access-session';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService, private readonly prisma: PrismaService) {
    const secret = config.get<string>('JWT_SECRET_KEY');
    if (!secret) throw new Error('JWT_SECRET_KEY is not set in .env');
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request) => request?.cookies?.access_token,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: SessionTokenPayload) {
    return validateAccessSession(this.prisma, payload);
  }
}

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';
import { ALLOW_BEFORE_PLATFORM_TERMS } from './platform-terms.decorator';
import { PlatformTermsService } from './platform-terms.service';

@Injectable()
export class PlatformTermsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly terms: PlatformTermsService) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
        this.reflector.getAllAndOverride<boolean>(ALLOW_BEFORE_PLATFORM_TERMS, targets)) return true;
    const user = context.switchToHttp().getRequest().user;
    // El guard JWT registrado antes es responsable de rechazar sesiones ausentes.
    if (!user?.id) return false;
    await this.terms.assertAccepted(user.id);
    return true;
  }
}

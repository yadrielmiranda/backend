import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { IS_PUBLIC_KEY } from '@/auth/public.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const user = request?.user as AuthUser | undefined;

    // El rol técnico no hereda los endpoints generales de una sesión comercial.
    // Se exige una autorización explícita, también cuando no hay @Roles.
    if (!requiredRoles || requiredRoles.length === 0)
      return user?.role?.name !== 'technician';

    if (!user?.role?.name) return false;

    const required = requiredRoles.map((r) => String(r).toLowerCase());
    const userRole = String(user.role.name).toLowerCase();

    return required.includes(userRole);
  }
}

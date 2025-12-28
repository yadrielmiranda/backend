import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from 'src/auth/roles.decorator';
import type { AuthUser } from 'src/auth/types/auth-user.type';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request?.user as AuthUser | undefined;

    if (!user?.role?.name) return false;

    const required = requiredRoles.map((r) => String(r).toLowerCase());
    const userRole = String(user.role.name).toLowerCase();

    return required.includes(userRole);
  }
}

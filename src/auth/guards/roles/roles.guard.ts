import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from 'src/auth/roles.decorator';


@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Obtenemos los roles requeridos del decorador @Roles('admin')
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    
    // Si no se especifican roles, permitimos el acceso
    if (!requiredRoles) {
      return true;
    }

    // Obtenemos el usuario que fue decodificado del token JWT por el JwtAuthGuard
    const { user } = context.switchToHttp().getRequest();

    // Comprobamos si el rol del usuario está en la lista de roles requeridos
    return requiredRoles.some((role) => user.role?.name === role);
  }
}
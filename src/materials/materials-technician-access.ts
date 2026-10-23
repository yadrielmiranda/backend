import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@/auth/types/auth-user.type';

export function assertMaterialsTechnician(actor: AuthUser) {
  if (!Number.isSafeInteger(actor?.id) || actor.id <= 0 || actor.role?.name !== 'technician')
    throw new ForbiddenException('This operation is available to technicians only.');
}

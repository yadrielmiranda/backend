import type { AuthUser, RoleName } from '../types/auth-user.type';

export function getRoleName(
  user: AuthUser | undefined | null,
): RoleName | undefined {
  return user?.role?.name;
}

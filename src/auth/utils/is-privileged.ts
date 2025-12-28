import type { AuthUser } from '../types/auth-user.type';
import { getRoleName } from './get-role-name';

export function isPrivileged(user: AuthUser | undefined | null) {
  const roleName = getRoleName(user ?? undefined);
  return roleName === 'admin' || roleName === 'operator';
}

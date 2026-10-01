import type { Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { canAccessOwner } from '@/dealer-network/dealer-network';

export async function canShareEstimate(
  db: Prisma.TransactionClient,
  estimate: { idUser: number; user: { role: { name: string } } } | null,
  actor: AuthUser,
): Promise<boolean> {
  if (
    !estimate ||
    estimate.user.role.name !== 'dealer' ||
    !['admin', 'dealer'].includes(actor.role?.name ?? '')
  )
    return false;

  return canAccessOwner(db, estimate.idUser, actor);
}

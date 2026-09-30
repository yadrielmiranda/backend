import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { isPrivileged } from '@/auth/utils/is-privileged';
import { installationDuplicationInclude } from '@/installation/installation-duplication';

export const estimateDuplicationInclude = {
  user: { include: { role: true } },
  pieces: {
    orderBy: { id: 'asc' as const },
    include: {
      pieceMuntin: {
        include: { panels: { orderBy: { panelIndex: 'asc' as const } } },
      },
    },
  },
  customerCharges: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
  installationJob: { include: installationDuplicationInclude },
} satisfies Prisma.EstimateInclude;

export type EstimateDuplicationSource = Prisma.EstimateGetPayload<{
  include: typeof estimateDuplicationInclude;
}>;

export function assertEstimateDuplicationAccess(
  source: EstimateDuplicationSource | null,
  actor: AuthUser,
  networkAccess = false,
): asserts source is EstimateDuplicationSource {
  if (!source || (!networkAccess && !isPrivileged(actor) && source.idUser !== actor.id)) {
    throw new NotFoundException('Estimate not found.');
  }
  if (!isPrivileged(actor) && !['dealer', 'client'].includes(actor.role?.name ?? '')) {
    throw new ForbiddenException('You cannot duplicate this estimate.');
  }
  if (!source.user.isActive || !['dealer', 'client'].includes(source.user.role.name)) {
    throw new BadRequestException('The estimate owner must be an active dealer or client.');
  }
}

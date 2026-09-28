import { Prisma } from '@prisma/client';

// Se leen únicamente los datos de cotización; no se copian trámites ni trabajo realizado.
export const installationDuplicationInclude = {
  permit: true,
  quotes: {
    orderBy: { version: 'desc' as const },
    take: 1,
    include: { lines: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] } },
  },
} satisfies Prisma.InstallationJobInclude;

export type InstallationDuplicationSource = Prisma.InstallationJobGetPayload<{
  include: typeof installationDuplicationInclude;
}>;

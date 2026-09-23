import type { Prisma } from '@prisma/client';

export const installationDestinationSelect = {
  id: true, status: true, installationAddress: true,
} satisfies Prisma.InstallationJobSelect;

// Se conserva la dirección confirmada en el movimiento aunque luego cambie la obra.
export function installationDestination(job: {
  id: number; status: string; installationAddress: Prisma.JsonValue | null;
} | null | undefined) {
  if (!job || job.status === 'CANCELED') return null;
  const value = job.installationAddress;
  const address: Prisma.JsonObject = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (key: string) => {
    const field = address[key];
    return typeof field === 'string' ? field.trim() : '';
  };
  return {
    id: job.id,
    address: [text('street'), text('city'), [text('state'), text('postalCode')].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  };
}

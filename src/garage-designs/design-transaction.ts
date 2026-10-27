import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/** Serializes compatibility/default changes with catalog deactivation. */
export async function designTransaction<T>(prisma: PrismaService, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: any) {
      if (error?.code !== 'P2034' || attempt >= 2) throw error;
    }
  }
}

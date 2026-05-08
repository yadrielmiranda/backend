// @/logs/logs.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type LogAction = 'CREATE' | 'UPDATE' | 'RECALCULATE' | 'DELETE' | 'LOGIN' | 'LOGOUT';

export type EventLogInput = {
  action: LogAction;
  entityType: string; // ej: "Order", "Estimate"
  entityId?: number | null;
  userId?: number | null;
  message?: string | null;
};

export type TempLogInput = {
  // comentario en espanol: se guarda ligado a un EventLog existente
  eventId: number;
  before?: unknown | null;
  after?: unknown | null;
  meta?: Record<string, unknown> | null;
};

@Injectable()
export class LogsService {
  constructor(private prisma: PrismaService) {}

  // =====================================================
  // Event log (permanente): liviano, siempre se conserva
  // =====================================================
  async event(input: EventLogInput) {
    return this.prisma.eventLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        userId: input.userId ?? null,
        message: input.message ?? null,
      },
    });
  }

  // =====================================================
  // Temp log (temporal): pesado, se puede borrar cada X días  // 
  // =====================================================
  async temp(input: TempLogInput) {
    return this.prisma.tempLog.create({
      data: {
        eventId: input.eventId,
        before: (input.before ?? null) as Prisma.InputJsonValue,
        after: (input.after ?? null) as Prisma.InputJsonValue,
        meta: (input.meta ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  // =====================================================
  // Helper "pro": crea event y (si quieres) temp en 1 llamada
  // =====================================================
  async log(params: EventLogInput & { before?: unknown; after?: unknown; meta?: Record<string, unknown> | null }) {
    return this.prisma.$transaction(async (tx) => {
      const ev = await tx.eventLog.create({
        data: {
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          userId: params.userId ?? null,
          message: params.message ?? null,
        },
      });

      const hasTemp =
        params.before !== undefined ||
        params.after !== undefined ||
        params.meta !== undefined;

      if (hasTemp) {
        await tx.tempLog.create({
          data: {
            eventId: ev.id,
            before: (params.before ?? null) as Prisma.InputJsonValue,
            after: (params.after ?? null) as Prisma.InputJsonValue,
            meta: (params.meta ?? null) as Prisma.InputJsonValue,
          },
        });
      }

      return ev;
    });
  }
}

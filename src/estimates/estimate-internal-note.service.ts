import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { canAccessOwner } from '@/dealer-network/dealer-network';
import { PrismaService } from '@/prisma/prisma.service';
import { UpdateEstimateInternalNoteDto } from './dto/estimate-internal-note.dto';

const noteInclude = {
  updatedBy: { select: { id: true, firstName: true, lastName: true, username: true } },
} satisfies Prisma.EstimateInternalNoteInclude;

type SavedNote = Prisma.EstimateInternalNoteGetPayload<{ include: typeof noteInclude }>;
const conflictMessage = 'This note was changed by someone else. Review the latest note before saving again.';

function presentNote(note: SavedNote | null, actor: AuthUser) {
  return {
    internalNote: note ? {
      text: note.text,
      version: note.version,
      updatedAt: note.updatedAt,
      updatedBy: {
        id: note.updatedBy?.id ?? null,
        name: note.updatedBy
          ? [note.updatedBy.firstName, note.updatedBy.lastName].filter(Boolean).join(' ').trim() || note.updatedBy.username
          : 'Deleted user',
      },
    } : null,
    canEdit: actor.role?.name === 'admin' || actor.role?.name === 'dealer',
  };
}

@Injectable()
export class EstimateInternalNoteService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAccess(db: Prisma.TransactionClient, estimateId: number, actor: AuthUser, write = false) {
    const roles = write ? ['admin', 'dealer'] : ['admin', 'operator', 'dealer'];
    if (!roles.includes(actor.role?.name ?? ''))
      throw new ForbiddenException(write ? 'You cannot edit internal estimate notes.' : 'You cannot view internal estimate notes.');
    const estimate = await db.estimate.findUnique({
      where: { id: estimateId }, select: { id: true, idUser: true },
    });
    if (!estimate || !await canAccessOwner(db, estimate.idUser, actor))
      throw new NotFoundException('Estimate not found.');
  }

  async getForEstimate(estimateId: number, actor: AuthUser) {
    await this.assertAccess(this.prisma, estimateId, actor);
    const note = await this.prisma.estimateInternalNote.findUnique({
      where: { estimateId }, include: noteInclude,
    });
    return presentNote(note, actor);
  }

  async saveForEstimate(estimateId: number, dto: UpdateEstimateInternalNoteDto, actor: AuthUser) {
    try {
      return await this.prisma.$transaction(async tx => {
        await this.assertAccess(tx, estimateId, actor, true);
        const text = dto.text.trim();
        if (dto.expectedVersion === 0) {
          const note = await tx.estimateInternalNote.create({
            data: { estimateId, text, updatedById: actor.id }, include: noteInclude,
          });
          return presentNote(note, actor);
        }
        // La versión evita que dos usuarios sobrescriban sus notas sin advertencia.
        const result = await tx.estimateInternalNote.updateMany({
          where: { estimateId, version: dto.expectedVersion },
          data: { text, updatedById: actor.id, version: { increment: 1 } },
        });
        if (result.count !== 1) throw new ConflictException(conflictMessage);
        const note = await tx.estimateInternalNote.findUniqueOrThrow({
          where: { estimateId }, include: noteInclude,
        });
        return presentNote(note, actor);
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException(conflictMessage);
      throw error;
    }
  }
}

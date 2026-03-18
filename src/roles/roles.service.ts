import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
import { UpdateRoleDto } from './dto/update-role.dto';
import { LogsService } from 'src/logs/logs.service';
import type { AuthUser } from 'src/auth/types/auth-user.type';
import { getRoleName } from 'src/auth/utils/get-role-name'; 

@Injectable()
export class RolesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) {}

  async findAll(): Promise<Role[]> {
    return this.prisma.role.findMany({
      orderBy: { id: 'asc' },
    });
  }

  // ✅ MISMO NOMBRE: update
  async update(id: number, dto: UpdateRoleDto, actor: AuthUser): Promise<Role> {
    const before = await this.prisma.role.findUnique({ where: { id } });

    if (!before) {
      throw new NotFoundException(`Role with ID #${id} not found.`);
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        markup: dto.markup,
      },
    });

    // comentario en espanol: auditoria simple (por ahora solo markup)
    const changedFields: string[] = [];
    if (
      dto.markup !== undefined &&
      before.markup?.toString() !== updated.markup?.toString()
    ) {
      changedFields.push('markup');
    }

    await this.logs.log({
      action: 'UPDATE',
      entityType: 'Role',
      entityId: updated.id,
      userId: actor.id, // ✅ quien lo hizo
      message: `Role updated (#${updated.id})`,
      before: {
        id: before.id,
        name: before.name,
        markup: before.markup,
      },
      after: {
        id: updated.id,
        name: updated.name,
        markup: updated.markup,
      },
      meta: {
        source: 'RolesService.update',
        actorUserId: actor.id,
        actorRole: getRoleName(actor) ?? null,
        changedFields,
      },
    });

    return updated;
  }
}

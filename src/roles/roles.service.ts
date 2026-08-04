import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Role } from '@prisma/client';
import { UpdateRoleDto } from './dto/update-role.dto';
import { LogsService } from '@/logs/logs.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { getRoleName } from '@/auth/utils/get-role-name'; 

@Injectable()
export class RolesService {
  constructor(
    private prisma: PrismaService,
    private logs: LogsService,
  ) {}

  async findAll() {
    return this.prisma.role.findMany({
      include: { installationPriceProfile: true },
      orderBy: { id: 'asc' },
    });
  }

  // ✅ MISMO NOMBRE: update
  async update(id: number, dto: UpdateRoleDto, actor: AuthUser): Promise<Role> {
    const before = await this.prisma.role.findUnique({ where: { id } });

    if (!before) {
      throw new NotFoundException(`Role with ID #${id} not found.`);
    }

    if (dto.installationPriceProfileId != null) {
      const profile = await this.prisma.installationPriceProfile.findFirst({
        where: { id: dto.installationPriceProfileId, isActive: true },
        select: { id: true },
      });
      if (!profile) {
        throw new BadRequestException('The selected installation price profile is unavailable.');
      }
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        markup: dto.markup,
        ...(dto.installationPriceProfileId !== undefined
          ? {
              installationPriceProfile:
                dto.installationPriceProfileId === null
                  ? { disconnect: true }
                  : { connect: { id: dto.installationPriceProfileId } },
            }
          : {}),
      },
      include: { installationPriceProfile: true },
    });

    // comentario en espanol: auditoria simple (por ahora solo markup)
    const changedFields: string[] = [];
    if (
      dto.markup !== undefined &&
      before.markup?.toString() !== updated.markup?.toString()
    ) {
      changedFields.push('markup');
    }
    if (
      dto.installationPriceProfileId !== undefined &&
      before.installationPriceProfileId !== updated.installationPriceProfileId
    ) {
      changedFields.push('installationPriceProfileId');
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
        installationPriceProfileId: before.installationPriceProfileId,
      },
      after: {
        id: updated.id,
        name: updated.name,
        markup: updated.markup,
        installationPriceProfileId: updated.installationPriceProfileId,
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

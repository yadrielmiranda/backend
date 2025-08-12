import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
import { UpdateRoleDto } from './dto/update-role.dto'; // <-- Importar DTO

@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  async findAll(): Promise<Role[]> {
    return this.prisma.role.findMany({
      orderBy: { id: 'asc' }, // Ordenar por ID
    });
  }

  async update(id: number, dto: UpdateRoleDto): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });

    if (!role) {
      throw new NotFoundException(`Role with ID #${id} not found.`);
    }

    return this.prisma.role.update({
      where: { id },
      data: {
        markup: dto.markup,
      },
    });
  }
}
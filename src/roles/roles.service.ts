import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';

@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Devuelve una lista de todos los roles.
   */
  async findAll(): Promise<Role[]> {
    return this.prisma.role.findMany();
  }
}

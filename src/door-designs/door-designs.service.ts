import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

@Injectable()
export class DoorDesignsService {
  constructor(private readonly db: PrismaService) {}

  list() { return this.db.frenchDoorDesign.findMany({ orderBy: [{ kind: 'asc' }, { code: 'asc' }] }); }

  async edit(id: number, data: { code?: string; unitPrice?: string | null }) {
    if (data.code === undefined && data.unitPrice === undefined) throw new BadRequestException('Choose a code or price to update.');
    try {
      return await this.db.frenchDoorDesign.update({ where: { id }, data: { code: data.code, unitPrice: data.unitPrice } });
    } catch (error) {
      if (error?.code === 'P2002') throw new ConflictException('This door design code is already in use.');
      if (error?.code === 'P2025') throw new NotFoundException('Door design not found.');
      throw error;
    }
  }
}

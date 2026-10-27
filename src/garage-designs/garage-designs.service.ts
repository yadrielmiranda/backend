import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateDesignColorDto, CreateDesignPatternDto, UpdateDesignColorDto, UpdateDesignPatternDto } from './dto/design-catalog.dto';
import { isSafeDesignPreviewReference } from './design-preview-reference';
import { designTransaction } from './design-transaction';
import { readGarageDesignTemplate } from './design-template';

const orderBy = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }, { id: 'asc' as const }];

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
    throw new BadRequestException(`${label} is required and must contain at most ${limit} characters.`);
  return value.trim();
}

function reference(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !isSafeDesignPreviewReference(value.trim()))
    throw new BadRequestException('Use an HTTP/HTTPS image URL or a local path beginning with a single /.');
  return value.trim();
}

function common(data: { isActive?: boolean; sortOrder?: number }) {
  if (data.isActive !== undefined && typeof data.isActive !== 'boolean')
    throw new BadRequestException('Active must be true or false.');
  if (data.sortOrder !== undefined && (!Number.isSafeInteger(data.sortOrder) || data.sortOrder < 0))
    throw new BadRequestException('Sort order must be a nonnegative integer.');
  return { ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}) };
}

function patternData(data: UpdateDesignPatternDto) {
  const template = data.template === undefined ? undefined :
    data.template === null ? Prisma.DbNull : readGarageDesignTemplate(data.template);
  if (template === null) throw new BadRequestException('Invalid design template. Use a version 1 grid with matching slat/glass cells and positive row/column weights summing to 1.');
  return { ...common(data),
    ...(data.name !== undefined ? { name: text(data.name, 'Name', 100) } : {}),
    ...(data.imageUrl !== undefined ? { imageUrl: reference(data.imageUrl) } : {}),
    ...(template !== undefined ? { template } : {}) };
}

function colorData(data: UpdateDesignColorDto) {
  const hexCode = data.hexCode === undefined ? undefined : text(data.hexCode, 'Color', 7).toUpperCase();
  if (hexCode !== undefined && !/^#[0-9A-F]{6}$/.test(hexCode))
    throw new BadRequestException('Color must use #RRGGBB format.');
  if (data.idFrameColor !== undefined && (!Number.isSafeInteger(data.idFrameColor) || Number(data.idFrameColor) <= 0))
    throw new BadRequestException('Choose an existing frame color for this design color.');
  return { ...common(data), ...(hexCode !== undefined ? { hexCode } : {}),
    ...(data.idFrameColor !== undefined ? { idFrameColor: data.idFrameColor } : {}),
    ...(data.name !== undefined ? { name: text(data.name, 'Name', 100) } : {}) };
}

@Injectable()
export class GarageDesignsService {
  constructor(private readonly prisma: PrismaService) {}

  patterns() { return this.prisma.designPattern.findMany({ orderBy }); }
  colors() { return this.prisma.designColor.findMany({ orderBy }); }

  private rethrow(error: any): never {
    if (error?.code === 'P2002') throw new ConflictException('A design color with this name already exists.');
    if (error?.code === 'P2025') throw new NotFoundException('Design or color not found.');
    if (error?.code === 'P2003') throw new BadRequestException('The associated frame color is no longer available. Choose an existing frame color.');
    throw error;
  }

  private async validateFrameColor(id: number, tx: Prisma.TransactionClient) {
    const frame = await tx.frameColor.findUnique({ where: { id }, select: { id: true, isActive: true } });
    if (!frame?.isActive) throw new BadRequestException('Choose an active frame color. Create it in Frame Colors first if it does not exist.');
  }

  async createPattern(data: CreateDesignPatternDto) {
    const normalized = patternData(data);
    if (!normalized.name) throw new BadRequestException('Name is required.');
    try {
      return await this.prisma.designPattern.create({ data: { ...normalized, name: normalized.name } });
    } catch (error) { this.rethrow(error); }
  }

  async createColor(data: CreateDesignColorDto) {
    const normalized = colorData(data);
    if (!normalized.name || !normalized.hexCode) throw new BadRequestException('Name and color are required.');
    if (!normalized.idFrameColor) throw new BadRequestException('Choose an existing frame color for this design color.');
    try {
      return await designTransaction(this.prisma, async tx => {
        await this.validateFrameColor(normalized.idFrameColor!, tx);
        return tx.designColor.create({ data: { ...normalized, name: normalized.name!, hexCode: normalized.hexCode! } });
      });
    } catch (error) { this.rethrow(error); }
  }

  async updatePattern(id: number, data: UpdateDesignPatternDto) {
    const normalized = patternData(data);
    try {
      return await designTransaction(this.prisma, async tx => {
        if (normalized.isActive === false && await tx.system.findFirst({
          where: { allowDesign: true, defaultDesignId: id }, select: { id: true },
        })) throw new ConflictException('This design is a default for an enabled series. Change its default or disable Design first.');
        return tx.designPattern.update({ where: { id }, data: normalized });
      });
    } catch (error) { this.rethrow(error); }
  }

  async deletePattern(id: number): Promise<{ id: number }> {
    try {
      return await designTransaction(this.prisma, async tx => {
        const pattern = await tx.designPattern.findUnique({ where: { id }, select: { id: true } });
        if (!pattern) throw new NotFoundException('Design not found.');

        const [option, defaultSystem, piece] = await Promise.all([
          tx.systemDesignOption.findFirst({ where: { idDesign: id }, select: { idSystem: true } }),
          tx.system.findFirst({ where: { defaultDesignId: id }, select: { id: true } }),
          tx.piece.findFirst({ where: { idDesign: id }, select: { id: true } }),
        ]);
        if (piece) throw new ConflictException('This design is used by saved pieces and cannot be deleted. Deactivate it instead.');
        if (option || defaultSystem) throw new ConflictException('Remove this design from all series and their defaults before deleting it.');

        return tx.designPattern.delete({ where: { id }, select: { id: true } });
      });
    } catch (error: any) {
      if (error?.code === 'P2003') throw new ConflictException('This design is still referenced. Remove it from all series and their defaults, or deactivate it if saved pieces use it.');
      this.rethrow(error);
    }
  }

  async updateColor(id: number, data: UpdateDesignColorDto) {
    const normalized = colorData(data);
    try {
      return await designTransaction(this.prisma, async tx => {
        if (normalized.idFrameColor !== undefined) await this.validateFrameColor(normalized.idFrameColor, tx);
        if (normalized.isActive === false && await tx.system.findFirst({
          where: { allowDesign: true, defaultDesignColorId: id }, select: { id: true },
        })) throw new ConflictException('This color is a default for an enabled series. Change its default or disable Design first.');
        return tx.designColor.update({ where: { id }, data: normalized });
      });
    } catch (error) { this.rethrow(error); }
  }
}

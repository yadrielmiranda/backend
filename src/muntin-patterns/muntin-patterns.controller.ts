import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { MuntinPattern } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';
import { CreateMuntinPatternDto } from './dto/create-muntin-pattern.dto';
import { UpdateMuntinPatternDto } from './dto/update-muntin-pattern.dto';
import { MuntinPatternsService } from './muntin-patterns.service';

@Controller('muntin-patterns')
export class MuntinPatternsController {
  constructor(private readonly muntinPatternsService: MuntinPatternsService) {}

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createMuntinPattern(
    @Body() data: CreateMuntinPatternDto,
  ): Promise<MuntinPattern> {
    return this.muntinPatternsService.createMuntinPattern(data);
  }

  // ✅ READ: todos los usuarios autenticados
  @Get()
  async getMuntinPatterns(
    @Query('active') active?: string,
  ): Promise<MuntinPattern[]> {
    const where =
      active === undefined ? {} : { isActive: active === 'true' };

    return this.muntinPatternsService.muntinPatterns({
      where,
      orderBy: { name: 'asc' },
    });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getMuntinPattern(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MuntinPattern> {
    return this.muntinPatternsService.muntinPattern({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateMuntinPattern(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateMuntinPatternDto,
  ): Promise<MuntinPattern> {
    return this.muntinPatternsService.updateMuntinPattern({
      where: { id },
      data,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteMuntinPattern(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MuntinPattern> {
    return this.muntinPatternsService.deleteMuntinPattern({ id });
  }
}
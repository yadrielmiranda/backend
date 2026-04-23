import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ActiveOption as ActiveOptionModel } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';
import { ActiveOptionsService } from './active-options.service';
import { CreateActiveOptionDto } from './dto/create-active-option.dto';
import { UpdateActiveOptionDto } from './dto/update-active-option.dto';

@Controller('active-options')
export class ActiveOptionsController {
  constructor(private readonly activeOptionsService: ActiveOptionsService) {}

  // READ: todos los usuarios autenticados
  @Get()
  async getAllActiveOptions(): Promise<ActiveOptionModel[]> {
    return this.activeOptionsService.activeOptions({});
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  async getActiveOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ActiveOptionModel> {
    return this.activeOptionsService.activeOption({ id });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Post()
  async createActiveOption(
    @Body() data: CreateActiveOptionDto,
  ): Promise<ActiveOptionModel> {
    return this.activeOptionsService.createActiveOption({
      name: data.name,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateActiveOption(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateActiveOptionDto,
  ): Promise<ActiveOptionModel> {
    return this.activeOptionsService.updateActiveOption({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteActiveOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ActiveOptionModel> {
    return this.activeOptionsService.deleteActiveOption({ id });
  }
}
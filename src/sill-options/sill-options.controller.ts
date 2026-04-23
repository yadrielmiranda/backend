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
import { Roles } from '@/auth/roles.decorator';
import { SillOption as SillOptionModel } from '@prisma/client';
import { SillOptionsService } from './sill-options.service';
import { CreateSillOptionDto } from './dto/create-sill-option.dto';
import { UpdateSillOptionDto } from './dto/update-sill-option.dto';

@Controller('sill-options')
export class SillOptionsController {
  constructor(private readonly sillOptionsService: SillOptionsService) {}

  // READ: todos los usuarios autenticados
  @Get()
  async getAllSillOptions(): Promise<SillOptionModel[]> {
    return this.sillOptionsService.sillOptions({});
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  async getSillOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SillOptionModel> {
    return this.sillOptionsService.sillOption({ id });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Post()
  async createSillOption(
    @Body() data: CreateSillOptionDto,
  ): Promise<SillOptionModel> {
    return this.sillOptionsService.createSillOption({
      name: data.name,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateSillOption(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateSillOptionDto,
  ): Promise<SillOptionModel> {
    return this.sillOptionsService.updateSillOption({
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
  async deleteSillOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SillOptionModel> {
    return this.sillOptionsService.deleteSillOption({ id });
  }
}
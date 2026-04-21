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
import { PreparationOption as PreparationOptionModel } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';
import { PreparationOptionsService } from './preparation-options.service';
import { CreatePreparationOptionDto } from './dto/create-preparation-option.dto';
import { UpdatePreparationOptionDto } from './dto/update-preparation-option.dto';

@Controller('preparation-options')
export class PreparationOptionsController {
  constructor(
    private readonly preparationOptionsService: PreparationOptionsService,
  ) {}

  // READ: todos los usuarios autenticados
  @Get()
  async getAllPreparationOptions(): Promise<PreparationOptionModel[]> {
    return this.preparationOptionsService.preparationOptions({});
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  async getPreparationOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PreparationOptionModel> {
    return this.preparationOptionsService.preparationOption({ id });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Post()
  async createPreparationOption(
    @Body() data: CreatePreparationOptionDto,
  ): Promise<PreparationOptionModel> {
    return this.preparationOptionsService.createPreparationOption({
      name: data.name,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updatePreparationOption(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdatePreparationOptionDto,
  ): Promise<PreparationOptionModel> {
    return this.preparationOptionsService.updatePreparationOption({
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
  async deletePreparationOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PreparationOptionModel> {
    return this.preparationOptionsService.deletePreparationOption({ id });
  }
}
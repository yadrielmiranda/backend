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
import { ReinforcementOption as ReinforcementOptionModel } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';
import { ReinforcementOptionsService } from './reinforcement-options.service';
import { CreateReinforcementOptionDto } from './dto/create-reinforcement-option.dto';
import { UpdateReinforcementOptionDto } from './dto/update-reinforcement-option.dto';

@Controller('reinforcement-options')
export class ReinforcementOptionsController {
  constructor(
    private readonly reinforcementOptionsService: ReinforcementOptionsService,
  ) {}

  // READ: todos los usuarios autenticados
  @Get()
  async getAllReinforcementOptions(): Promise<ReinforcementOptionModel[]> {
    return this.reinforcementOptionsService.reinforcementOptions({});
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  async getReinforcementOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReinforcementOptionModel> {
    return this.reinforcementOptionsService.reinforcementOption({ id });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Post()
  async createReinforcementOption(
    @Body() data: CreateReinforcementOptionDto,
  ): Promise<ReinforcementOptionModel> {
    return this.reinforcementOptionsService.createReinforcementOption({
      name: data.name,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateReinforcementOption(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateReinforcementOptionDto,
  ): Promise<ReinforcementOptionModel> {
    return this.reinforcementOptionsService.updateReinforcementOption({
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
  async deleteReinforcementOption(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReinforcementOptionModel> {
    return this.reinforcementOptionsService.deleteReinforcementOption({ id });
  }
}
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
import { MuntinType } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';
import { CreateMuntinTypeDto } from './dto/create-muntin-type.dto';
import { UpdateMuntinTypeDto } from './dto/update-muntin-type.dto';
import { MuntinTypesService } from './muntin-types.service';

@Controller('muntin-types')
export class MuntinTypesController {
  constructor(private readonly muntinTypesService: MuntinTypesService) {}

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createMuntinType(
    @Body() data: CreateMuntinTypeDto,
  ): Promise<MuntinType> {
    return this.muntinTypesService.createMuntinType(data);
  }

  // ✅ READ: todos los usuarios autenticados
  @Get()
  async getMuntinTypes(
    @Query('active') active?: string,
  ): Promise<MuntinType[]> {
    const where =
      active === undefined ? {} : { isActive: active === 'true' };

    return this.muntinTypesService.muntinTypes({
      where,
      orderBy: { name: 'asc' },
    });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getMuntinType(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MuntinType> {
    return this.muntinTypesService.muntinType({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateMuntinType(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateMuntinTypeDto,
  ): Promise<MuntinType> {
    return this.muntinTypesService.updateMuntinType({
      where: { id },
      data,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteMuntinType(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MuntinType> {
    return this.muntinTypesService.deleteMuntinType({ id });
  }
}
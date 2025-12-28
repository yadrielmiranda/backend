import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from '@nestjs/common';
import { TintService } from './tints.service';
import { CreateTintDto } from './dto/create-tint.dto';
import { UpdateTintDto } from './dto/update-tint.dto';
import { Tint as TintModel } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';

@Controller('tints')
export class TintController {
  constructor(private readonly tintService: TintService) {}

  // 🔒 WRITE: solo admin
  @Post()
  @Roles('admin')
  async createTint(@Body() tintData: CreateTintDto): Promise<TintModel> {
    return this.tintService.createTint(tintData);
  }

  // ✅ READ: todos los usuarios autenticados
  @Get()
  async getAllTints(): Promise<TintModel[]> {
    return this.tintService.tints({});
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id') 
  async getTintById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TintModel> {
    return this.tintService.tint({ id });
  }

  // 🔒 WRITE: solo admin
  @Patch(':id')
  @Roles('admin')
  async updateTint(
    @Param('id', ParseIntPipe) id: number,
    @Body() tintData: UpdateTintDto,
  ): Promise<TintModel> {
    return this.tintService.updateTint({
      where: { id },
      data: tintData,
    });
  }

  // 🔒 WRITE: solo admin
  @Delete(':id')
  @Roles('admin')
  async deleteTint(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TintModel> {
    return this.tintService.deleteTint({ id });
  }
}

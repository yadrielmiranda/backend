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
import { CoatingService } from './coating.service';
import { CreateCoatingDto } from './dto/create-coating.dto';
import { UpdateCoatingDto } from './dto/update-coating.dto';
import { Coating as CoatingModel } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';

@Controller('coatings')
export class CoatingController {
  constructor(private readonly coatingService: CoatingService) {}

  // ✅ READ: todos los usuarios autenticados 
  @Get()
  async getAllCoatings(): Promise<CoatingModel[]> {
    return this.coatingService.coatings({});
  }

  // ✅ READ: todos los usuarios autenticados  
  @Get(':id')
  async getCoatingById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<CoatingModel> {
    return this.coatingService.coating({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createCoating(@Body() coatingData: CreateCoatingDto): Promise<CoatingModel> {
    return this.coatingService.createCoating(coatingData);
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateCoating(
    @Param('id', ParseIntPipe) id: number,
    @Body() coatingData: UpdateCoatingDto,
  ): Promise<CoatingModel> {
    return this.coatingService.updateCoating({
      where: { id },
      data: coatingData,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteCoating(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<CoatingModel> {
    return this.coatingService.deleteCoating({ id });
  }
}

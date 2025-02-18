import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CoatingService } from './coating.service';
import { CreateCoatingDto } from './dto/create-coating.dto';
import { UpdateCoatingDto } from './dto/update-coating.dto';
import { Coating as CoatingModel } from '@prisma/client';

@Controller('coatings')
export class CoatingController {
  constructor(private readonly coatingService: CoatingService) { }

  @Post()
  async createCoating(
    @Body() coatingData: CreateCoatingDto,
  ): Promise<CoatingModel> {
    return this.coatingService.createCoating(coatingData);
  }

  @Get()
  async getAllCoating(): Promise<CoatingModel[]> {
    return this.coatingService.coatings({});
  }

  @Get(':id')
  async getCoating(@Param('id') id: string): Promise<CoatingModel> {
    return this.coatingService.coating({ id: Number(id) });
  }

  @Patch(':id')
  async updateCoating(
    @Param('id') id: string,
    @Body() coatingData: UpdateCoatingDto,
  ): Promise<CoatingModel> {
    return this.coatingService.updateCoating({
      where: { id: Number(id) },
      data: coatingData,
    });
  }

  @Delete(':id')
  async deleteCoating(@Param('id') id: string): Promise<CoatingModel> {
    return this.coatingService.deleteCoating({ id: Number(id) });
  }
}

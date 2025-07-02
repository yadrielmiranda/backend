import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe } from '@nestjs/common';
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
  async getAllCoatings(): Promise<CoatingModel[]> {
    return this.coatingService.coatings({});
  }

  @Get(':id')
  async getCoatingById(@Param('id', ParseIntPipe) id: number): Promise<CoatingModel> {
    return this.coatingService.coating({ id });
  }

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

  @Delete(':id')
  async deleteCoating(@Param('id', ParseIntPipe) id: number): Promise<CoatingModel> {
    return this.coatingService.deleteCoating({ id });
  }
}
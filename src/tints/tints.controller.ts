import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { TintsService } from './tints.service';
import { CreateTintDto } from './dto/create-tint.dto';
import { UpdateTintDto } from './dto/update-tint.dto';
import { Tint as TintModel } from '@prisma/client';

@Controller('tints')
export class TintsController {
  constructor(private readonly tintsService: TintsService) { }

  @Post()
  async createTint(
    @Body() tintData: CreateTintDto,
  ): Promise<TintModel> {
    return this.tintsService.createTint(tintData);
  }

  @Get()
  async getAllTints(): Promise<TintModel[]> {
    return this.tintsService.tints({});
  }

  @Get(':id')
  async getTint(@Param('id') id: string): Promise<TintModel> {
    return this.tintsService.tint({ id: Number(id) });
  }

  @Patch(':id')
  async updateTint(
    @Param('id') id: string,
    @Body() tintData: UpdateTintDto,
  ): Promise<TintModel> {
    return this.tintsService.updateTint({
      where: { id: Number(id) },
      data: tintData,
    });
  }

  @Delete(':id')
  async deleteTint(@Param('id') id: string): Promise<TintModel> {
    return this.tintsService.deleteTint({ id: Number(id) });
  }
}

import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe } from '@nestjs/common';
import { TintService } from './tints.service';
import { CreateTintDto } from './dto/create-tint.dto';
import { UpdateTintDto } from './dto/update-tint.dto';
import { Tint as TintModel } from '@prisma/client';


@Controller('tints')
export class TintController {
  constructor(private readonly tintService: TintService) { }

  @Post()
  async createTint(
    @Body() tintData: CreateTintDto,
  ): Promise<TintModel> {
    return this.tintService.createTint(tintData);
  }

  @Get()
  async getAllTints(): Promise<TintModel[]> {
    return this.tintService.tints({});
  }

  @Get(':id')
  async getTintById(@Param('id', ParseIntPipe) id: number): Promise<TintModel> {
    return this.tintService.tint({ id });
  }

  @Patch(':id')
  async updateTint(
    @Param('id', ParseIntPipe) id: number,
    @Body() tintData: UpdateTintDto,
  ): Promise<TintModel> {
    return this.tintService.updateTint({
      where: { id },
      data: tintData,
    });
  }

  @Delete(':id')
  async deleteTint(@Param('id', ParseIntPipe) id: number): Promise<TintModel> {
    return this.tintService.deleteTint({ id });
  }
}

import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { FrameColorService } from './frame-color.service';
import { CreateFrameColorDto } from './dto/create-frame-color.dto';
import { UpdateFrameColorDto } from './dto/update-frame-color.dto';
import { FrameColor as FrameColorModel } from '@prisma/client';

@Controller('framecolors')
export class FrameColorController {
  constructor(private readonly frameColorService: FrameColorService) { }

  @Post()
  async createFColor(
    @Body() frameColorData: CreateFrameColorDto,
  ): Promise<FrameColorModel> {
    return this.frameColorService.createColor(frameColorData);
  }

  @Get()
  async getAllFColorss(): Promise<FrameColorModel[]> {
    return this.frameColorService.colors({});
  }

  @Get(':id')
  async getFColor(@Param('id') id: string): Promise<FrameColorModel> {
    return this.frameColorService.color({ id: Number(id) });
  }

  @Patch(':id')
  async updateFColor(
    @Param('id') id: string,
    @Body() colorData: UpdateFrameColorDto,
  ): Promise<FrameColorModel> {
    return this.frameColorService.updateColor({
      where: { id: Number(id) },
      data: colorData,
    });
  }

  @Delete(':id')
  async deleteFColor(@Param('id') id: string): Promise<FrameColorModel> {
    return this.frameColorService.deleteColor({ id: Number(id) });
  }

}

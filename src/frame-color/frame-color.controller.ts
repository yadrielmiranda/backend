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
import { FrameColorService } from './frame-color.service';
import { CreateFrameColorDto } from './dto/create-frame-color.dto';
import { UpdateFrameColorDto } from './dto/update-frame-color.dto';
import { FrameColor as FrameColorModel } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';

@Controller('framecolors')
export class FrameColorController {
  constructor(private readonly frameColorService: FrameColorService) { }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createFColor(
    @Body() frameColorData: CreateFrameColorDto,
  ): Promise<FrameColorModel> {
    return this.frameColorService.createColor(frameColorData);
  }

  // ✅ READ: todos los usuarios autenticados 
  @Get()
  async getAllFColors(): Promise<FrameColorModel[]> {
    return this.frameColorService.colors({});
  }

  @Get('globals')
  getGlobals() {
    return this.frameColorService.getGlobalDefaults();
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getFColor(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<FrameColorModel> {
    return this.frameColorService.color({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateFColor(
    @Param('id', ParseIntPipe) id: number,
    @Body() colorData: UpdateFrameColorDto,
  ): Promise<FrameColorModel> {
    return this.frameColorService.updateColor({
      where: { id },
      data: colorData,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteFColor(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<FrameColorModel> {
    return this.frameColorService.deleteColor({ id });
  }
}

import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { FrameColorService } from './frame-color.service';
import { CreateFrameColorDto } from './dto/create-frame-color.dto';
import { UpdateFrameColorDto } from './dto/update-frame-color.dto';

@Controller('frame-color')
export class FrameColorController {
  constructor(private readonly frameColorService: FrameColorService) {}

  @Post()
  create(@Body() createFrameColorDto: CreateFrameColorDto) {
    return this.frameColorService.create(createFrameColorDto);
  }

  @Get()
  findAll() {
    return this.frameColorService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.frameColorService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateFrameColorDto: UpdateFrameColorDto) {
    return this.frameColorService.update(+id, updateFrameColorDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.frameColorService.remove(+id);
  }
}

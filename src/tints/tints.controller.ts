import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { TintsService } from './tints.service';
import { CreateTintDto } from './dto/create-tint.dto';
import { UpdateTintDto } from './dto/update-tint.dto';

@Controller('tints')
export class TintsController {
  constructor(private readonly tintsService: TintsService) {}

  @Post()
  create(@Body() createTintDto: CreateTintDto) {
    return this.tintsService.create(createTintDto);
  }

  @Get()
  findAll() {
    return this.tintsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tintsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateTintDto: UpdateTintDto) {
    return this.tintsService.update(+id, updateTintDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tintsService.remove(+id);
  }
}

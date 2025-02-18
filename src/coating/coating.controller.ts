import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CoatingService } from './coating.service';
import { CreateCoatingDto } from './dto/create-coating.dto';
import { UpdateCoatingDto } from './dto/update-coating.dto';

@Controller('coating')
export class CoatingController {
  constructor(private readonly coatingService: CoatingService) {}

  @Post()
  create(@Body() createCoatingDto: CreateCoatingDto) {
    return this.coatingService.create(createCoatingDto);
  }

  @Get()
  findAll() {
    return this.coatingService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.coatingService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCoatingDto: UpdateCoatingDto) {
    return this.coatingService.update(+id, updateCoatingDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.coatingService.remove(+id);
  }
}

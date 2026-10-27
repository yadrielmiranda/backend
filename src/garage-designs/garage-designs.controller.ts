import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import { CreateDesignColorDto, CreateDesignPatternDto, UpdateDesignColorDto, UpdateDesignPatternDto } from './dto/design-catalog.dto';
import { GarageDesignsService } from './garage-designs.service';

@Controller('garage-designs')
export class GarageDesignsController {
  constructor(private readonly service: GarageDesignsService) {}

  @Get('patterns')
  patterns() { return this.service.patterns(); }

  @Get('colors')
  colors() { return this.service.colors(); }

  @Roles('admin')
  @Post('patterns')
  createPattern(@Body() data: CreateDesignPatternDto) { return this.service.createPattern(data); }

  @Roles('admin')
  @Patch('patterns/:id')
  updatePattern(@Param('id', ParseIntPipe) id: number, @Body() data: UpdateDesignPatternDto) {
    return this.service.updatePattern(id, data);
  }

  @Roles('admin')
  @Delete('patterns/:id')
  deletePattern(@Param('id', ParseIntPipe) id: number) {
    return this.service.deletePattern(id);
  }

  @Roles('admin')
  @Post('colors')
  createColor(@Body() data: CreateDesignColorDto) { return this.service.createColor(data); }

  @Roles('admin')
  @Patch('colors/:id')
  updateColor(@Param('id', ParseIntPipe) id: number, @Body() data: UpdateDesignColorDto) {
    return this.service.updateColor(id, data);
  }
}

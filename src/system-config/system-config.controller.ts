import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { CreateSystemConfigDto } from './dto/create-system-config.dto';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';

@Controller('system-config')
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Post()
  create(@Body() createSystemConfigDto: CreateSystemConfigDto) {
    return this.systemConfigService.create(createSystemConfigDto);
  }

  @Get()
  findAll() {
    return this.systemConfigService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.systemConfigService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateSystemConfigDto: UpdateSystemConfigDto) {
    return this.systemConfigService.update(+id, updateSystemConfigDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.systemConfigService.remove(+id);
  }
}

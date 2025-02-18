import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ConfigSService } from './config-s.service';
import { CreateConfigDto } from './dto/create-config-.dto';
import { UpdateConfigDto } from './dto/update-config-.dto';

@Controller('config-s')
export class ConfigSController {
  constructor(private readonly configSService: ConfigSService) {}

  @Post()
  create(@Body() createConfigDto: CreateConfigDto) {
    return this.configSService.create(createConfigDto);
  }

  @Get()
  findAll() {
    return this.configSService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.configSService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateConfigDto: UpdateConfigDto) {
    return this.configSService.update(+id, updateConfigDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.configSService.remove(+id);
  }
}

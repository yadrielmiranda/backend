import { Controller, Get, Post, Body, Patch, Param, Delete, ParseIntPipe } from '@nestjs/common';
import { ConfigSService } from './config-s.service';
import { CreateConfigDto } from './dto/create-config-.dto';
import { UpdateConfigDto } from './dto/update-config-.dto';
import { Config as ConfigModel } from '@prisma/client';

@Controller('configs')
export class ConfigSController {
  constructor(private readonly configSService: ConfigSService) { }

  @Post()
  async createConfig(
    @Body() confData: CreateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.createConfig({
      conf: confData.conf,
      prod: {
        connect: { id: confData.idProduct },
      },
      requiresWidth: confData.requiresWidth,
      requiresHeight: confData.requiresHeight,
      requiresHeightLeft: confData.requiresHeightLeft,
      requiresHeightRight: confData.requiresHeightRight,
      requiresLegHeight: confData.requiresLegHeight,
    });
  }


  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  @Get(':id')
  async getConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel | null> {
    return this.configSService.config({ id });
  }

  
  @Get(':id/product')
  async getConfigWithProduct(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel | null> {
    return this.configSService.getConfigWithProduct({ id });
  }

  @Patch(':id')
  async updateConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: { id: id },
      data: confData,
    });
  }

  @Delete(':id')
  async deleteConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id: id });
  }
}
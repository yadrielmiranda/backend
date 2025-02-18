import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
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
    const { conf, idProduct } = confData;
    return this.configSService.createConfig({  //Aqui es donde se verifica que exista ese idProduct en la tabla product
      conf,
      prod: {
        connect: { id: idProduct },
      },
    });
  }

  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  @Get(':id')
  async getConfig(@Param('id') id: string): Promise<ConfigModel> {
    return this.configSService.config({ id: Number(id) });
  }

  @Patch(':id')
  async updateConfig(
    @Param('id') id: string,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: { id: Number(id) },
      data: confData,
    });
  }

  @Delete(':id')
  async deleteConfig(@Param('id') id: string): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id: Number(id) });
  }
}

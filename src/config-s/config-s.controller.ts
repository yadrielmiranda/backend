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
import { ConfigSService } from './config-s.service';
import { CreateConfigDto } from './dto/create-config.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { Config as ConfigModel } from '@prisma/client';
import { Roles } from 'src/auth/roles.decorator';

@Controller('configs')
export class ConfigSController {
  constructor(private readonly configSService: ConfigSService) {}

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Post()
  async createConfig(@Body() confData: CreateConfigDto): Promise<ConfigModel> {
    return this.configSService.createConfig({
      conf: confData.conf,
      prod: { connect: { id: confData.idProduct } },

      // flags (si vienen undefined, Prisma los deja como default/nullable según schema)
      requiresWidth: confData.requiresWidth,
      requiresHeight: confData.requiresHeight,
      requiresHeightLeft: confData.requiresHeightLeft,
      requiresHeightRight: confData.requiresHeightRight,
      requiresLegHeight: confData.requiresLegHeight,
    });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  // ✅ READ: todos los usuarios autenticados 
  @Get(':id/product')
  async getConfigWithProduct(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.getConfigWithProduct({ id });
  }

  // ✅ READ: todos los usuarios autenticados
  @Get(':id')
  async getConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.config({ id });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: { id },
      data: confData,
    });
  }

  // 🔒 WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id });
  }
}

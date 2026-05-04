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
import { Config as ConfigModel, Prisma } from '@prisma/client';
import { Roles } from '@/auth/roles.decorator';

@Controller('configs')
export class ConfigSController {
  constructor(private readonly configSService: ConfigSService) { }

  private toMuntinLayoutJson(
    muntinLayout?: CreateConfigDto['muntinLayout'] | UpdateConfigDto['muntinLayout'],
  ): Prisma.InputJsonValue | undefined {
    if (muntinLayout === undefined) return undefined;

    return muntinLayout.map((item) => ({
      panelIndex: item.panelIndex,
      panelCode: item.panelCode,
      ...(item.panelLabel !== undefined ? { panelLabel: item.panelLabel } : {}),
    })) as Prisma.InputJsonValue;
  }

  // WRITE: solo admin
  @Roles('admin')
  @Post()
  async createConfig(@Body() confData: CreateConfigDto): Promise<ConfigModel> {
    return this.configSService.createConfig({
      conf: confData.conf,
      prod: { connect: { id: confData.idProduct } },

      requiresWidth: confData.requiresWidth,
      requiresHeight: confData.requiresHeight,
      requiresHeightLeft: confData.requiresHeightLeft,
      requiresHeightRight: confData.requiresHeightRight,
      requiresLegHeight: confData.requiresLegHeight,

      // layout de muntin por config
      muntinLayout: this.toMuntinLayoutJson(confData.muntinLayout),
    });
  }

  // READ: todos los usuarios autenticados
  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  // READ: todos los usuarios autenticados
  @Get(':id/product')
  async getConfigWithProduct(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.getConfigWithProduct({ id });
  }

  // READ: todos los usuarios autenticados
  @Get(':id')
  async getConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.config({ id });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Patch(':id')
  async updateConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: { id },
      data: {
        ...(confData.conf !== undefined ? { conf: confData.conf } : {}),
        
        ...(confData.isActive !== undefined
          ? { isActive: confData.isActive }
          : {}),

        ...(confData.idProduct !== undefined
          ? { prod: { connect: { id: confData.idProduct } } }
          : {}),

        ...(confData.requiresWidth !== undefined
          ? { requiresWidth: confData.requiresWidth }
          : {}),
        ...(confData.requiresHeight !== undefined
          ? { requiresHeight: confData.requiresHeight }
          : {}),
        ...(confData.requiresHeightLeft !== undefined
          ? { requiresHeightLeft: confData.requiresHeightLeft }
          : {}),
        ...(confData.requiresHeightRight !== undefined
          ? { requiresHeightRight: confData.requiresHeightRight }
          : {}),
        ...(confData.requiresLegHeight !== undefined
          ? { requiresLegHeight: confData.requiresLegHeight }
          : {}),

        ...(confData.muntinLayout !== undefined
          ? {
            muntinLayout: this.toMuntinLayoutJson(confData.muntinLayout),
          }
          : {}),
      },
    });
  }

  // WRITE: solo admin
  @Roles('admin')
  @Delete(':id')
  async deleteConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id });
  }
}
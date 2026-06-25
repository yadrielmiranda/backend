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

  @Roles('admin')
  @Post()
  async createConfig(@Body() confData: CreateConfigDto): Promise<ConfigModel> {
    return this.configSService.createConfig({
      idProduct: confData.idProduct,
      categoryId: confData.categoryId,
      data: {
        conf: confData.conf.trim(),
        prod: { connect: { id: confData.idProduct } },

        ...(confData.categoryId !== undefined && confData.categoryId !== null
          ? { category: { connect: { id: confData.categoryId } } }
          : {}),

        requiresWidth: confData.requiresWidth,
        requiresHeight: confData.requiresHeight,
        requiresHeightLeft: confData.requiresHeightLeft,
        requiresHeightRight: confData.requiresHeightRight,
        requiresLegHeight: confData.requiresLegHeight,
        requiresSashHeight: confData.requiresSashHeight,

        muntinLayout: this.toMuntinLayoutJson(confData.muntinLayout),
      },
    });
  }

  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  @Get(':id/product')
  async getConfigWithProduct(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.getConfigWithProduct({ id });
  }

  @Get(':id')
  async getConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.config({ id });
  }

  @Roles('admin')
  @Patch(':id')
  async updateConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: { id },
      idProduct: confData.idProduct,
      categoryId: confData.categoryId,
      data: {
        ...(confData.conf !== undefined ? { conf: confData.conf.trim() } : {}),

        ...(confData.isActive !== undefined
          ? { isActive: confData.isActive }
          : {}),

        ...(confData.idProduct !== undefined
          ? { prod: { connect: { id: confData.idProduct } } }
          : {}),

        ...(confData.categoryId !== undefined
          ? confData.categoryId === null
            ? { category: { disconnect: true } }
            : { category: { connect: { id: confData.categoryId } } }
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
        ...(confData.requiresSashHeight !== undefined
          ? { requiresSashHeight: confData.requiresSashHeight }
          : {}),

        ...(confData.muntinLayout !== undefined
          ? {
            muntinLayout: this.toMuntinLayoutJson(confData.muntinLayout),
          }
          : {}),
      },
    });
  }

  @Roles('admin')
  @Delete(':id')
  async deleteConfig(@Param('id', ParseIntPipe) id: number): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id });
  }
}
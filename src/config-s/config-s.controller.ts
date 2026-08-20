// src/configs/config-s.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { Config as ConfigModel, Prisma } from "@prisma/client";

import { Roles } from "@/auth/roles.decorator";

import { ConfigSService } from "./config-s.service";
import { CreateConfigDto } from "./dto/create-config.dto";
import { UpdateConfigDto } from "./dto/update-config.dto";

@Controller("configs")
export class ConfigSController {
  constructor(private readonly configSService: ConfigSService) { }

  private toMuntinLayoutJson(
    muntinLayout?:
      | CreateConfigDto["muntinLayout"]
      | UpdateConfigDto["muntinLayout"],
  ): Prisma.InputJsonValue | undefined {
    if (muntinLayout === undefined) {
      return undefined;
    }

    return muntinLayout.map((item) => ({
      panelIndex: item.panelIndex,
      panelCode: item.panelCode,
      ...(item.panelLabel !== undefined
        ? { panelLabel: item.panelLabel }
        : {}),
    })) as Prisma.InputJsonValue;
  }

  private toDiagramSpecJson(
    diagramSpec?:
      | CreateConfigDto["diagramSpec"]
      | UpdateConfigDto["diagramSpec"],
  ):
    | Prisma.InputJsonValue
    | Prisma.NullableJsonNullValueInput
    | undefined {
    if (diagramSpec === undefined) {
      return undefined;
    }

    // null elimina el valor de la columna JSON.
    if (diagramSpec === null) {
      return Prisma.DbNull;
    }

    return diagramSpec as Prisma.InputJsonValue;
  }

  @Roles("admin")
  @Post()
  async createConfig(
    @Body() confData: CreateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.createConfig({
      idProduct: confData.idProduct,
      categoryId: confData.categoryId,
      data: {
        conf: confData.conf.trim(),
        prod: {
          connect: {
            id: confData.idProduct,
          },
        },

        ...(confData.categoryId !== undefined &&
          confData.categoryId !== null
          ? {
            category: {
              connect: {
                id: confData.categoryId,
              },
            },
          }
          : {}),

        requiresWidth: confData.requiresWidth,
        requiresHeight: confData.requiresHeight,
        requiresHeightLeft: confData.requiresHeightLeft,
        requiresHeightRight: confData.requiresHeightRight,
        requiresLegHeight: confData.requiresLegHeight,
        requiresSashHeight: confData.requiresSashHeight,
        requiresWindowHeight: confData.requiresWindowHeight,
        fixedPanelCount: confData.fixedPanelCount,

        muntinLayout: this.toMuntinLayoutJson(
          confData.muntinLayout,
        ),

        diagramSpec: this.toDiagramSpecJson(
          confData.diagramSpec,
        ),

        diagramSpecVersion: confData.diagramSpecVersion,
      },
    });
  }

  @Get()
  async getAllConfigs(): Promise<ConfigModel[]> {
    return this.configSService.configs({});
  }

  @Get(":id/product")
  async getConfigWithProduct(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.getConfigWithProduct({ id });
  }

  @Get(":id")
  async getConfig(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.config({ id });
  }

  @Roles("admin")
  @Patch(":id")
  async updateConfig(
    @Param("id", ParseIntPipe) id: number,
    @Body() confData: UpdateConfigDto,
  ): Promise<ConfigModel> {
    return this.configSService.updateConfig({
      where: {
        id,
      },
      idProduct: confData.idProduct,
      categoryId: confData.categoryId,
      fixedPanelCount: confData.fixedPanelCount,
      data: {
        ...(confData.conf !== undefined
          ? {
            conf: confData.conf.trim(),
          }
          : {}),

        ...(confData.isActive !== undefined
          ? {
            isActive: confData.isActive,
          }
          : {}),

        ...(confData.idProduct !== undefined
          ? {
            prod: {
              connect: {
                id: confData.idProduct,
              },
            },
          }
          : {}),

        ...(confData.categoryId !== undefined
          ? confData.categoryId === null
            ? {
              category: {
                disconnect: true,
              },
            }
            : {
              category: {
                connect: {
                  id: confData.categoryId,
                },
              },
            }
          : {}),

        ...(confData.requiresWidth !== undefined
          ? {
            requiresWidth: confData.requiresWidth,
          }
          : {}),

        ...(confData.requiresHeight !== undefined
          ? {
            requiresHeight: confData.requiresHeight,
          }
          : {}),

        ...(confData.requiresHeightLeft !== undefined
          ? {
            requiresHeightLeft:
              confData.requiresHeightLeft,
          }
          : {}),

        ...(confData.requiresHeightRight !== undefined
          ? {
            requiresHeightRight:
              confData.requiresHeightRight,
          }
          : {}),

        ...(confData.requiresLegHeight !== undefined
          ? {
            requiresLegHeight:
              confData.requiresLegHeight,
          }
          : {}),

        ...(confData.requiresSashHeight !== undefined
          ? {
            requiresSashHeight:
              confData.requiresSashHeight,
          }
          : {}),

        ...(confData.requiresWindowHeight !== undefined
          ? {
            requiresWindowHeight:
              confData.requiresWindowHeight,
          }
          : {}),

        ...(confData.fixedPanelCount !== undefined
          ? {
            fixedPanelCount: confData.fixedPanelCount,
          }
          : {}),

        ...(confData.muntinLayout !== undefined
          ? {
            muntinLayout: this.toMuntinLayoutJson(
              confData.muntinLayout,
            ),
          }
          : {}),

        ...(confData.diagramSpec !== undefined
          ? {
            diagramSpec: this.toDiagramSpecJson(
              confData.diagramSpec,
            ),
          }
          : {}),

        ...(confData.diagramSpecVersion !== undefined
          ? {
            diagramSpecVersion:
              confData.diagramSpecVersion,
          }
          : {}),
      },
    });
  }

  @Roles("admin")
  @Delete(":id")
  async deleteConfig(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<ConfigModel> {
    return this.configSService.deleteConfig({ id });
  }
}
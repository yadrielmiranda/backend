// src/configs/dto/create-config.dto.ts

import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

export class CreateConfigMuntinLayoutItemDto {
  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  panelIndex: number;

  @IsString()
  @IsNotEmpty()
  panelLabel: string;

  @IsOptional()
  @IsString()
  panelCode?: string | null;
}

export class CreateConfigDto {
  @IsString()
  @IsNotEmpty()
  conf: string;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  idProduct: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;

  @IsOptional()
  @IsBoolean()
  requiresWidth?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresHeight?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresHeightLeft?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresHeightRight?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresLegHeight?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresSashHeight?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresWindowHeight?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fixedPanelCount?: number | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateConfigMuntinLayoutItemDto)
  muntinLayout?: CreateConfigMuntinLayoutItemDto[];

  @IsOptional()
  @IsObject()
  diagramSpec?: Record<string, unknown> | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  diagramSpecVersion?: number;
}
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateConfigMuntinLayoutItemDto)
  muntinLayout?: CreateConfigMuntinLayoutItemDto[];
}
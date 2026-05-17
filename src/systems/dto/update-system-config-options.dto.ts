import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsOptional } from 'class-validator';
import { DimensionMode } from '@prisma/client';

export class UpdateSystemConfigOptionsDto {
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  activeOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  preparationOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  sillOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  reinforcementOptionIds: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultActiveOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultPreparationOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultSillOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultReinforcementOptionId?: number | null;

  @IsOptional()
  @IsEnum(DimensionMode)
  dimensionMode?: DimensionMode;

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
  requiresDoorWidth?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresLeftSideliteWidth?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresRightSideliteWidth?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresLeftPanels?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresRightPanels?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresPanelCount?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresHorizontalHeights?: boolean;
}
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsEnum, IsBoolean, IsString } from 'class-validator';

export enum DimensionSizeBasis {
  FRAME = 'FRAME',
  DLO = 'DLO',
}

export enum DimensionRounding {
  ROUND_UP_TO_NEXT = 'ROUND_UP_TO_NEXT',
  NEAREST = 'NEAREST',
}

export class CreatePolicyDto {
  @Type(() => Number)
  @IsInt()
  idSystem: number;

  @Type(() => Number)
  @IsInt()
  idConfig: number;

  @Type(() => Number)
  @IsInt()
  idCrystal: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idReinforcementOption?: number | null;

  @IsEnum(DimensionSizeBasis)
  sizeBasis: DimensionSizeBasis = DimensionSizeBasis.FRAME;

  @IsEnum(DimensionRounding)
  roundingRule: DimensionRounding = DimensionRounding.ROUND_UP_TO_NEXT;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;
}

export class UpdatePolicyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idSystem?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idConfig?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idCrystal?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  idReinforcementOption?: number | null;

  @IsOptional()
  @IsEnum(DimensionSizeBasis)
  sizeBasis?: DimensionSizeBasis;

  @IsOptional()
  @IsEnum(DimensionRounding)
  roundingRule?: DimensionRounding;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
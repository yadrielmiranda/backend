import { IsInt, IsOptional, IsEnum, IsBoolean, IsString } from 'class-validator';

export enum DimensionSizeBasis { FRAME='FRAME', DLO='DLO' }
export enum DimensionRounding { ROUND_UP_TO_NEXT='ROUND_UP_TO_NEXT', NEAREST='NEAREST' }

export class CreatePolicyDto {
  @IsInt() idSystem: number;
  @IsInt() idConfig: number;
  @IsInt() idCrystal: number;

  @IsEnum(DimensionSizeBasis) sizeBasis: DimensionSizeBasis = DimensionSizeBasis.FRAME;
  @IsEnum(DimensionRounding) roundingRule: DimensionRounding = DimensionRounding.ROUND_UP_TO_NEXT;

  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean = true;
}

export class UpdatePolicyDto {
  @IsOptional() @IsEnum(DimensionSizeBasis) sizeBasis?: DimensionSizeBasis;
  @IsOptional() @IsEnum(DimensionRounding) roundingRule?: DimensionRounding;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

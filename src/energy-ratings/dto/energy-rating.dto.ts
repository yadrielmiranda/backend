import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

export class CreateEnergyRatingDto {
  @IsInt() @Min(1) idSystem: number;
  @IsInt() @Min(1) idCrystal: number;
  @IsInt() @Min(1) idTint: number;
  @IsInt() @Min(1) idCoating: number;
  @IsInt() @Min(1) idPrivacy: number;
  @IsOptional() @IsInt() @Min(1) idConfig?: number | null;
  @IsOptional() @IsBoolean() appliesToAllConfigs?: boolean;
  // Validate the complete triple in the service; preserve decimal strings.
  @Allow() uFactor?: string | number | null;
  @Allow() shgc?: string | number | null;
  @Allow() vlt?: string | number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateEnergyRatingDto extends PartialType(CreateEnergyRatingDto) {}

export class FindEnergyRatingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idSystem?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idCrystal?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idTint?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idCoating?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idPrivacy?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) idConfig?: number;
  @IsOptional()
  @Transform(({ obj, key }) =>
    obj[key] === 'true' ? true : obj[key] === 'false' ? false : obj[key],
  )
  @IsBoolean()
  isActive?: boolean;
}

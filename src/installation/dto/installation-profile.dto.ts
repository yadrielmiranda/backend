import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateInstallationPriceProfileDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(-99.9999)
  adjustmentPercent: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minimumCharge: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateInstallationPriceProfileDto extends PartialType(
  CreateInstallationPriceProfileDto,
) {}


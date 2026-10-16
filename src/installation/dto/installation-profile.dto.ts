import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class InstallationProfileRateAdjustmentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  serviceId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ruleId?: number | null;

  @IsIn(['AMOUNT', 'PERCENT'])
  type: 'AMOUNT' | 'PERCENT';

  @Transform(({ obj, key }) => typeof obj[key] === 'number' ? obj[key]
    : typeof obj[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(obj[key].trim()) ? Number(obj[key]) : Number.NaN)
  @IsNumber({ maxDecimalPlaces: 4 })
  // The service accepts negative values only when preserving a migrated row.
  value: number;
}

export class CreateInstallationPriceProfileDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @Type(() => Number)
  @Equals(0, { message: 'Use separate service and rule adjustments instead of a global percentage.' })
  adjustmentPercent?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => InstallationProfileRateAdjustmentDto)
  adjustments?: InstallationProfileRateAdjustmentDto[];

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


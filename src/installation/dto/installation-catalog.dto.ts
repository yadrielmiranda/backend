import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  InstallationBillingUnit,
  InstallationRuleMetric,
} from '@prisma/client';

// Conserva null para que el catálogo aplique cero al tiempo base o herencia al rango.
// Rechaza vacíos y booleanos en lugar de convertirlos en números.
const estimatedMinutesValue = ({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}) => {
  const value = obj[key];
  if (value === null || value === undefined) return value;
  return typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
};

export class InstallationServiceRuleDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minValue?: number | null;

  @IsOptional()
  @IsBoolean()
  minInclusive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxValue?: number | null;

  @IsOptional()
  @IsBoolean()
  maxInclusive?: boolean;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rate: number;

  @IsOptional()
  @Transform(estimatedMinutesValue)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999.9999)
  estimatedMinutes?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateInstallationServiceDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsEnum(InstallationBillingUnit)
  billingUnit: InstallationBillingUnit;

  @IsEnum(InstallationRuleMetric)
  ruleMetric: InstallationRuleMetric;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  baseRate: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minimumCharge?: number;

  @IsOptional()
  @Transform(estimatedMinutesValue)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999.9999)
  estimatedMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  availableForRequest?: boolean;

  @IsOptional()
  @IsBoolean()
  availableForField?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InstallationServiceRuleDto)
  rules?: InstallationServiceRuleDto[];
}

export class UpdateInstallationServiceDto extends PartialType(
  CreateInstallationServiceDto,
) {}

export class SetSysConfInstallationServicesDto {
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  serviceIds: number[];
}

export class SysConfInstallationTargetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  idSystem: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  idConfig: number;
}

export class AddBulkSysConfInstallationServiceDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  serviceId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SysConfInstallationTargetDto)
  targets: SysConfInstallationTargetDto[];
}

import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  InstallationBillingUnit,
  InstallationRuleMetric,
} from '@prisma/client';

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

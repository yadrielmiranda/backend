import { Type } from 'class-transformer';
import {
  IsNumber,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsArray,
  IsEnum,
} from 'class-validator';
import { DimensionRuleType } from '@prisma/client';

export class RuleRowDto {
  @IsNumber()
  widthIn: number;

  @IsNumber()
  heightIn: number;

  @IsOptional()
  @IsEnum(DimensionRuleType)
  ruleType?: DimensionRuleType;

  @IsNumber()
  dpPosPsf: number;

  @IsNumber()
  dpNegPsf: number;

  @IsInt()
  screws: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class BulkUpsertRulesDto {
  @IsOptional()
  @IsEnum(DimensionRuleType)
  ruleType?: DimensionRuleType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleRowDto)
  rows: RuleRowDto[];
}
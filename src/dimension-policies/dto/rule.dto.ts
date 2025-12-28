import { Type } from 'class-transformer';
import { IsNumber, IsInt, IsOptional, IsString, ValidateNested, IsArray } from 'class-validator';

export class RuleRowDto {
  @IsNumber()
  widthIn: number;

  @IsNumber()
  heightIn: number;

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleRowDto)
  rows: RuleRowDto[];
}
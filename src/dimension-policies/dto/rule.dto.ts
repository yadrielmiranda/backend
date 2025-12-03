import { IsNumber, IsInt, IsOptional, IsString } from 'class-validator';

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
  rows: RuleRowDto[];
}

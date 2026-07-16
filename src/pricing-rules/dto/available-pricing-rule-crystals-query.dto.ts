import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class AvailablePricingRuleCrystalsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  idSystem: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  idConfig: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  excludeRuleId?: number;
}
import { Type } from "class-transformer";
import { IsInt, IsOptional, Min } from "class-validator";

export class FindPricingRangesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  idSystem?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  idConfig?: number;
}

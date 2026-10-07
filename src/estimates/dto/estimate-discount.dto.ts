import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

export class EstimateDiscountRuleDto {
  @IsIn(['PERCENTAGE', 'AMOUNT'])
  type!: 'PERCENTAGE' | 'AMOUNT';

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(9999999999.99)
  value!: number;
}

export class UpdateEstimateDiscountDto {
  @IsOptional()
  @IsIn(['MATERIAL', 'INSTALLATION'])
  scope?: 'MATERIAL' | 'INSTALLATION';

  @IsOptional()
  @IsIn(['PERCENTAGE', 'AMOUNT'])
  type?: 'PERCENTAGE' | 'AMOUNT';

  @ValidateIf((dto) => dto.material === undefined && dto.installation === undefined || dto.value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(9999999999.99)
  value?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => EstimateDiscountRuleDto)
  material?: EstimateDiscountRuleDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => EstimateDiscountRuleDto)
  installation?: EstimateDiscountRuleDto | null;
}

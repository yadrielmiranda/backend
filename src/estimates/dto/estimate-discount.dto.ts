import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateEstimateDiscountDto {
  @IsOptional()
  @IsIn(['MATERIAL', 'INSTALLATION'])
  scope?: 'MATERIAL' | 'INSTALLATION';

  @IsOptional()
  @IsIn(['PERCENTAGE', 'AMOUNT'])
  type?: 'PERCENTAGE' | 'AMOUNT';

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(9999999999.99)
  value!: number;
}

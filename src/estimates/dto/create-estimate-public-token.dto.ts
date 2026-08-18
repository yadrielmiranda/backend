import { IsIn, IsOptional } from 'class-validator';

export type CustomerReportPricingMode = 'detailed' | 'total';

export class CreateEstimatePublicTokenDto {
  @IsOptional()
  @IsIn(['detailed', 'total'])
  pricingMode?: CustomerReportPricingMode;
}

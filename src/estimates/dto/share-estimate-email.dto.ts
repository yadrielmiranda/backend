import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, MaxLength } from 'class-validator';
import type { CustomerReportPricingMode } from './create-estimate-public-token.dto';

export class ShareEstimateEmailDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsEmail()
  @MaxLength(254)
  to: string;

  @IsIn(['detailed', 'total'])
  pricingMode: CustomerReportPricingMode;

  // No convertir la cadena "false" en true mediante la conversión implícita.
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  includeContract: boolean;
}

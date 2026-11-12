import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsString, ValidateBy, ValidateIf } from 'class-validator';
import { ESTIMATE_EMAIL_RECIPIENTS_ERROR, parseEstimateEmailRecipients } from '@/notifications/estimate-email-recipients';
import type { CustomerReportPricingMode } from './create-estimate-public-token.dto';

export class ShareEstimateEmailDto {
  @Transform(({ obj, key }) => {
    return parseEstimateEmailRecipients(obj.to, obj.cc)?.to ?? obj[key];
  })
  @ValidateBy({
    name: 'isEstimateEmailRecipients',
    validator: {
      validate: (value, args) => parseEstimateEmailRecipients(value, (args?.object as ShareEstimateEmailDto)?.cc) !== null,
      defaultMessage: () => ESTIMATE_EMAIL_RECIPIENTS_ERROR,
    },
  })
  to: string;

  @Transform(({ obj, key }) => {
    return parseEstimateEmailRecipients(obj.to, obj.cc)?.cc.join(', ') ?? obj[key];
  })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  cc?: string;

  @IsIn(['detailed', 'total'])
  pricingMode: CustomerReportPricingMode;

  // No convertir la cadena "false" en true mediante la conversión implícita.
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  includeContract: boolean;
}

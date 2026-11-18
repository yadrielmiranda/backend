import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsString, ValidateBy, ValidateIf } from 'class-validator';
import { ESTIMATE_EMAIL_RECIPIENTS_ERROR, parseEstimateEmailRecipients } from '@/notifications/estimate-email-recipients';
import { normalizeEstimateSmsPhone } from '../public-share/estimate-share-sms.service';
import type { CustomerReportPricingMode } from './create-estimate-public-token.dto';

export class ShareEstimateMessageDto {
  @Transform(({ obj, key }) => obj[key])
  @IsIn(['email', 'sms', 'both'])
  channel: 'email' | 'sms' | 'both';

  @Transform(({ obj, key }) => parseEstimateEmailRecipients(obj.to, obj.cc)?.to ?? obj[key])
  @ValidateIf(obj => obj.channel !== 'sms')
  @ValidateBy({
    name: 'isEstimateMessageEmailRecipients',
    validator: {
      validate: (value, args) => parseEstimateEmailRecipients(value, (args?.object as ShareEstimateMessageDto)?.cc) !== null,
      defaultMessage: () => ESTIMATE_EMAIL_RECIPIENTS_ERROR,
    },
  })
  to?: string;

  @Transform(({ obj, key }) => parseEstimateEmailRecipients(obj.to, obj.cc)?.cc.join(', ') ?? obj[key])
  @ValidateIf((obj, value) => obj.channel !== 'sms' && value !== undefined)
  @IsString()
  cc?: string;

  @Transform(({ obj, key }) => normalizeEstimateSmsPhone(obj[key]) ?? obj[key])
  @ValidateIf(obj => obj.channel !== 'email')
  @ValidateBy({
    name: 'isEstimateSmsPhone',
    validator: {
      validate: value => normalizeEstimateSmsPhone(value) !== null,
      defaultMessage: () => 'Enter a valid +1 mobile phone number for SMS.',
    },
  })
  phone?: string;

  @Transform(({ obj, key }) => obj[key])
  @IsIn(['detailed', 'total'])
  pricingMode: CustomerReportPricingMode;

  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  includeContract: boolean;
}

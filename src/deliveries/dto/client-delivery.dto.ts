import { IsBoolean, IsIn, IsOptional, Matches, ValidateIf } from 'class-validator';
import { ClientDeliveryChoice } from '@prisma/client';
import { US_STATE_CODES } from '@/common/us-states';
import { AddressConfirmationAddressDto } from './address-confirmation.dto';

export class ClientDeliveryAddressDto extends AddressConfirmationAddressDto {
  @IsIn(US_STATE_CODES)
  declare state: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  expectedProfileAddressKey?: string;

  @IsOptional()
  @IsBoolean()
  onlyIfMissing?: boolean;
}

export class ClientDeliveryDecisionDto {
  @IsIn(['PICKUP', 'DELIVERY'])
  choice: ClientDeliveryChoice;

  @ValidateIf(({ choice }) => choice === 'DELIVERY')
  @Matches(/^[a-f0-9]{64}$/)
  verificationKey?: string;
}

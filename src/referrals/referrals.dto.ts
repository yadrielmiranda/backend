import { IsBoolean, IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';

// Preserve the JSON primitive before the application's implicit type conversion.
const RawInput = () => Transform(({ obj, key }) => obj[key]);

export class SaveReferralBankDto {
  @IsString() @MinLength(1) @MaxLength(150) holderName: string;
  @IsEnum({ PERSONAL: 'PERSONAL', BUSINESS: 'BUSINESS' }) holderType: 'PERSONAL' | 'BUSINESS';
  @IsString() @MinLength(1) @MaxLength(100) bankName: string;
  @IsEnum({ CHECKING: 'CHECKING', SAVINGS: 'SAVINGS' }) accountType: 'CHECKING' | 'SAVINGS';
  @RawInput() @IsString() @Matches(/^\d{9}$/) routingNumber: string;
  @RawInput() @IsString() @Matches(/^\d{1,17}$/) accountNumber: string;
  @RawInput() @IsString() @Matches(/^\d{1,17}$/) confirmAccountNumber: string;
  @RawInput() @IsBoolean() authorized: boolean;
}

export class RequestReferralPayoutDto {
  @RawInput() @IsString() @Matches(/^\d{1,16}(?:\.\d{1,2})?$/) amount: string;
  @IsUUID() requestKey: string;
}

export class SaveReferralRoleDefaultDto {
  @IsEnum({ EXTERNAL_MARGIN: 'EXTERNAL_MARGIN', CUSTOM_PERCENT: 'CUSTOM_PERCENT', DEALER_PLAN: 'DEALER_PLAN' })
  mode: 'EXTERNAL_MARGIN' | 'CUSTOM_PERCENT' | 'DEALER_PLAN';
  @RawInput() @IsOptional() @IsString() @Matches(/^\d{1,3}(?:\.\d{1,4})?$/) percent?: string;
}

export class SaveReferralProfileDto {
  @RawInput() @IsBoolean() useRoleDefaults: boolean;
  @ValidateIf(o => o.useRoleDefaults === false) @RawInput() @IsBoolean() enabled?: boolean;
  @ValidateIf(o => o.useRoleDefaults === false)
  @IsEnum({ EXTERNAL_MARGIN: 'EXTERNAL_MARGIN', CUSTOM_PERCENT: 'CUSTOM_PERCENT', DEALER_PLAN: 'DEALER_PLAN' })
  mode?: 'EXTERNAL_MARGIN' | 'CUSTOM_PERCENT' | 'DEALER_PLAN';
  @RawInput() @IsOptional() @IsString() @Matches(/^\d{1,3}(?:\.\d{1,4})?$/) percent?: string;
}

export class SaveReferralSettingsDto {
  @RawInput() @IsString() @Matches(/^\d{1,16}(?:\.\d{1,2})?$/) minimumWithdrawal: string;
}

export class TransitionReferralPayoutDto {
  @IsEnum({ PROCESSING: 'PROCESSING', PAID: 'PAID', REJECTED: 'REJECTED', FAILED: 'FAILED', CANCELED: 'CANCELED' })
  status: 'PROCESSING' | 'PAID' | 'REJECTED' | 'FAILED' | 'CANCELED';
  @IsOptional() @IsString() @MaxLength(150) reference?: string;
  @IsOptional() @IsISO8601() paidAt?: string;
  @RawInput() @IsOptional() @IsString() @Matches(/^\d{1,16}(?:\.\d{1,2})?$/) bankFee?: string;
  @IsOptional() @IsString() @MaxLength(300) proofReference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @RawInput() @IsOptional() @IsBoolean() confirmedNotSent?: boolean;
}

export class RecoverReferralPayoutDto extends TransitionReferralPayoutDto {
  @IsEnum({ PAID: 'PAID', FAILED: 'FAILED' }) status: 'PAID' | 'FAILED';
  @RawInput() @IsInt() @Min(1) expectedProcessingById: number;
  @RawInput() @IsBoolean() bankOutcomeConfirmed: boolean;
}

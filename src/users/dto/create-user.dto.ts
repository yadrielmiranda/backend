import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsInt,
  IsOptional,
  IsPositive,
  IsPhoneNumber,
  Min,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { DealerMode } from '@prisma/client';
import { US_STATE_CODES } from '@/common/us-states';
import { transformAddressLine2 } from '@/common/address-line2';
import { PHONE_VALIDATION_MESSAGE, transformPhone } from '@/common/phone';
import {
  USERNAME_PATTERN,
  USERNAME_VALIDATION_MESSAGE,
} from '@/common/username-policy';
import {
  trimOnly,
  normalizeEmailOrNull,
  normalizeZip5OrNull,
  normalizeStateCodeOrNull,
} from '@/common/transforms';

export class CreateUserDto {
  @IsNotEmpty()
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_VALIDATION_MESSAGE })
  @Transform(trimOnly)
  username: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Transform(trimOnly)
  firstName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Transform(trimOnly)
  lastName: string;

  @IsNotEmpty()
  @IsEmail()
  @MaxLength(150)
  @Transform(normalizeEmailOrNull)
  email: string;

  // Store one canonical international number, including for legacy US inputs.
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  @Transform(transformPhone)
  @Matches(/^\+[1-9]\d{1,14}$/, { message: PHONE_VALIDATION_MESSAGE })
  @IsPhoneNumber(undefined, { message: PHONE_VALIDATION_MESSAGE })
  phone: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  password: string;

  // ✅ Nueva dirección (en vez de address)
  @IsNotEmpty()
  @IsString()
  @MaxLength(150)
  @Transform(trimOnly)
  street: string;

  @Transform(transformAddressLine2)
  @IsOptional()
  @IsString()
  @MaxLength(150)
  addressLine2?: string | null;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Transform(trimOnly)
  city: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(2)
  @Transform(normalizeStateCodeOrNull)
  @IsIn(US_STATE_CODES, {
    message: 'state must be a valid US state code (e.g. FL).',
  })
  state: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  @Transform(normalizeZip5OrNull)
  @Matches(/^\d{5}$/, { message: 'postalCode must be a valid ZIP (5 digits).' })
  postalCode: string;

  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  idRole: number;

  @IsOptional()
  @IsBoolean()
  isTaxExempt?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  installationPriceProfileId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  paymentPlanId?: number | null;

  @IsOptional()
  @IsEnum(DealerMode)
  dealerMode?: DealerMode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  dealerEarningsPlanId?: number | null;

  @IsOptional()
  @IsBoolean()
  noInstallationDeposit?: boolean;
}

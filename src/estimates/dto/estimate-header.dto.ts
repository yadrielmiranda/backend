import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import { US_STATE_CODES } from '@/common/us-states';
import { transformAddressLine2 } from '@/common/address-line2';
import { PHONE_VALIDATION_MESSAGE, transformPhone } from '@/common/phone';
import {
  normalizeEmailOrNull,
  normalizeStateCodeOrNull,
  normalizeZip5OrNull,
  trimOnly,
  trimOrNull,
} from '@/common/transforms';

export class CreateEstimateHeaderDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  @Transform(trimOnly)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerFirstName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerLastName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeEmailOrNull)
  @IsEmail()
  @MaxLength(150)
  customerEmail?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(transformPhone)
  @IsString()
  @MaxLength(30)
  @Matches(/^\+[1-9]\d{1,14}$/, { message: PHONE_VALIDATION_MESSAGE })
  @IsPhoneNumber(undefined, { message: PHONE_VALIDATION_MESSAGE })
  customerPhone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trimOrNull)
  customerStreet?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(transformAddressLine2)
  customerAddressLine2?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimOrNull)
  customerCity?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(normalizeStateCodeOrNull)
  @IsIn(US_STATE_CODES, {
    message:
      'customerState must be a valid US state code (e.g. FL).',
  })
  customerState?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(normalizeZip5OrNull)
  @MaxLength(20)
  @Matches(/^\d{5}$/, {
    message:
      'customerPostalCode must be a valid ZIP (5 digits)',
  })
  customerPostalCode?: string | null;

  // Impuesto que el dealer cobra al cliente.
  // Por ejemplo, 0.07 representa 7%.
  @ApiPropertyOptional({
    description:
      'Customer tax rate (e.g. 0.07 for 7%)',
    example: 0.07,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  customerTaxRate?: number;
}

export class UpdateEstimateHeaderDto extends PartialType(
  CreateEstimateHeaderDto,
) { }

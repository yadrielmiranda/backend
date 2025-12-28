import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { US_STATE_CODES } from "src/common/us-states";
import {
  trimOnly,
  normalizeEmailOrNull,
  normalizeUSPhoneE164OrNull,
  normalizeZip5OrNull,
  normalizeStateCodeOrNull,
} from "src/common/transforms";

export class CreateUserDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
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

  // E164 US estricto: +1 seguido de 10 dígitos
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  @Transform(normalizeUSPhoneE164OrNull)
  @Matches(/^\+1\d{10}$/, {
    message: "phone must be a valid US E.164 number (e.g. +13055551234).",
  })
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

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Transform(trimOnly)
  city: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(2)
  @Transform(normalizeStateCodeOrNull)
  @IsIn(US_STATE_CODES, { message: "state must be a valid US state code (e.g. FL)." })
  state: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10)
  @Transform(normalizeZip5OrNull)
  @Matches(/^\d{5}$/, { message: "postalCode must be a valid ZIP (5 digits)." })
  postalCode: string;

  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  idRole: number;

  @IsOptional()
  @IsBoolean()
  isTaxExempt?: boolean;
}

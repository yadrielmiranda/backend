import {
  Equals,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaymentMethod, PaymentType } from '@prisma/client';

export class RecordManualPaymentDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  estimateId: number;

  @IsEnum(PaymentType)
  type: PaymentType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  sequence?: number;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsBoolean()
  @Equals(true, {
    message: 'fundsVerified must confirm that the funds are already available.',
  })
  fundsVerified: true;

  @IsString()
  @MaxLength(150)
  @Transform(({ value }) => String(value ?? '').trim())
  reference: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }) => String(value ?? '').trim())
  note?: string;

  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @IsOptional()
  @IsBoolean()
  installationDepositTermsAccepted?: boolean;
}

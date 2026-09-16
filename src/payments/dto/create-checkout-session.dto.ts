// @/payments/dto/create-checkout-session.dto.ts
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID, IsBoolean, IsNumber, IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { PaymentType } from '@prisma/client';

export class CreateCheckoutSessionDto {
  @IsInt()
  @Min(1)
  estimateId: number;

  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @IsOptional()
  @IsInt()
  @Min(1)
  sequence?: number;

  @IsOptional()
  @IsUUID()
  checkoutRef?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  sequences?: number[];

  @IsOptional()
  @IsBoolean()
  payFullBalance?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  expectedBalance?: number;

  @IsOptional()
  @IsBoolean()
  installationDepositTermsAccepted?: boolean;

  @IsOptional()
  @IsBoolean()
  cityFeeAccepted?: boolean;

  @IsOptional()
  @IsBoolean()
  materialAccepted?: boolean;
}

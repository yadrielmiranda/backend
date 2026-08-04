// @/payments/dto/create-checkout-session.dto.ts
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';
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
  @IsBoolean()
  installationDepositTermsAccepted?: boolean;
}

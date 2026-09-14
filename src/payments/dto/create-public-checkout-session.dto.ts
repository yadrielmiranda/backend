import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentType } from '@prisma/client';

export class CreatePublicCheckoutSessionDto {
  @IsOptional()
  @IsUUID()
  agreementId?: string;

  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  sequence?: number;

  @IsOptional()
  @IsBoolean()
  installationDepositTermsAccepted?: boolean;
}

import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray,
  IsBoolean, IsNumber,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID, ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentType } from '@prisma/client';

export class PublicPaymentItemDto {
  @IsEnum(PaymentType)
  type: PaymentType;

  @IsInt()
  @Min(1)
  sequence: number;
}

export class CreatePublicCheckoutSessionDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PublicPaymentItemDto)
  items?: PublicPaymentItemDto[];

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
}

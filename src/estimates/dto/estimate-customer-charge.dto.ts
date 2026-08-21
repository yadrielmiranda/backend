import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  EstimateCustomerChargePricingMode,
  EstimateCustomerChargeSource,
} from '@prisma/client';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpsertSystemCustomerChargeDto {
  @IsEnum(EstimateCustomerChargeSource)
  source: EstimateCustomerChargeSource;

  @ValidateIf(
    (dto: UpsertSystemCustomerChargeDto) =>
      dto.source === EstimateCustomerChargeSource.INSTALLATION_SERVICE,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceRefId?: number;

  @IsEnum(EstimateCustomerChargePricingMode)
  pricingMode: EstimateCustomerChargePricingMode;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  value: number;

  // Optional for backward compatibility with an already-open older frontend.
  @IsOptional()
  @IsBoolean()
  usedInCustomerQuote?: boolean;
}

export class CreateDealerCustomerChargeDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  description: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;
}

export class UpdateDealerCustomerChargeDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;
}

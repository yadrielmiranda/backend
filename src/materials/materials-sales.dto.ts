import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsDateString,
  IsEmail, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max,
  MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class MaterialSaleLineDto {
  @Type(() => Number) @IsInt() @Min(1) presentationId: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) quantity: number;
}

export class CreateMaterialSaleDto {
  @IsUUID() requestKey: string;
  @Type(() => Number) @IsInt() @Min(1) storeId: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) customerUserId?: number;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ValidateIf(dto => dto.customerUserId == null || dto.customerName !== undefined)
  @IsString() @MinLength(1) @MaxLength(200) customerName?: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsOptional() @IsEmail() @MaxLength(200) customerEmail?: string;
  @IsOptional() @IsString() @MaxLength(40) customerPhone?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => MaterialSaleLineDto) lines: MaterialSaleLineDto[];
}

export class CustomerMaterialOrderDto {
  @IsUUID() requestKey: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => MaterialSaleLineDto) lines: MaterialSaleLineDto[];
}

export class MaterialSaleActionDto {
  @IsUUID() requestKey: string;
}

export class MaterialManualPaymentDto extends MaterialSaleActionDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) paymentMethod: PaymentMethod;
  @IsBoolean() @Equals(true) fundsVerified: true;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsDateString() paidAt?: string;
}

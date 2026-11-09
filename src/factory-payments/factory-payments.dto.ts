import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, MinLength,
} from 'class-validator';
import { FactoryPaymentKind } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateFactoryManufacturerDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(150)
  name: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateFactoryManufacturerDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(150)
  name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export enum FactoryPaymentStatus {
  ALL = 'ALL', PENDING_IMPORT = 'PENDING_IMPORT', UNPAID = 'UNPAID',
  PARTIAL = 'PARTIAL', PAID = 'PAID', CREDIT = 'CREDIT',
}

export class ListFactoryPaymentsDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) manufacturerId?: number;
  @IsOptional() @IsEnum(FactoryPaymentStatus) status?: FactoryPaymentStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class SaveFactoryPaymentAccountDto {
  @IsInt() @Min(1) @Max(2147483647) manufacturerId: number;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

export class SyncFactoryPaymentTotalDto {
  @IsInt() @Min(1) version: number;
}

export class CreateFactoryPaymentDto extends SaveFactoryPaymentAccountDto {
  @IsString() @Matches(/^\d{1,10}(?:\.\d{1,2})?$/)
  amount: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  paidOn: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  invoiceNumber: string;
  @IsEnum(FactoryPaymentKind) kind: FactoryPaymentKind;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(150) reference?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(4000) note?: string;
  @IsUUID('4') requestId: string;
}

export class VoidFactoryPaymentDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

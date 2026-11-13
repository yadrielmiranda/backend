import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DeliveryType } from '@prisma/client';
import { transformAddressLine2 } from '@/common/address-line2';
import { ConfirmedAddressLocationDto } from './confirmed-address-location.dto';

const trimmed = ({ value }: { value: unknown }) =>
  value == null ? value : String(value).trim();

export class CreateDeliveryDto {
  @IsOptional()
  @IsEnum(DeliveryType)
  type?: DeliveryType;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trimmed)
  street?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(transformAddressLine2)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimmed)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimmed)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trimmed)
  postalCode?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ConfirmedAddressLocationDto)
  confirmedLocation?: ConfirmedAddressLocationDto;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  taxable?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trimmed)
  internalReason?: string;
}

export class ScheduleDeliveryDto {
  @IsDateString()
  scheduledFor: string;
}

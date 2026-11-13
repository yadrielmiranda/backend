import { Transform, Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { transformAddressLine2 } from '@/common/address-line2';
import { ConfirmedAddressLocationDto } from './confirmed-address-location.dto';

const trim = ({ obj, key }: { obj: Record<string, unknown>; key: string }) =>
  typeof obj[key] === 'string' ? (obj[key] as string).trim() : obj[key];

export class AddressConfirmationAddressDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter the street address.' })
  @MaxLength(150)
  street: string;

  @Transform(transformAddressLine2)
  @IsOptional()
  @IsString()
  @MaxLength(150)
  addressLine2?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter the city.' })
  @MaxLength(100)
  city: string;

  @Transform(args => {
    const value = trim(args);
    return typeof value === 'string' ? value.toUpperCase() : value;
  })
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'Enter the two-letter state code.' })
  state: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\d{5}(?:-\d{4})?$/, { message: 'Enter a valid ZIP code.' })
  postalCode: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ConfirmedAddressLocationDto)
  confirmedLocation?: ConfirmedAddressLocationDto;
}

export class AddressConfirmationReviewDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressConfirmationAddressDto)
  address: AddressConfirmationAddressDto;

  @IsIn(['INSTALLATION', 'DELIVERY'])
  purpose: 'INSTALLATION' | 'DELIVERY';
}

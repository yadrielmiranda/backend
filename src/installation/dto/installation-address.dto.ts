import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { transformAddressLine2 } from '@/common/address-line2';

const trim = ({ obj, key }: { obj: Record<string, unknown>; key: string }) =>
  typeof obj[key] === 'string' ? (obj[key] as string).trim() : undefined;

export class InstallationAddressDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  street: string;

  @Transform(transformAddressLine2)
  @IsOptional()
  @IsString()
  @MaxLength(150)
  addressLine2?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city: string;

  @Transform((args) => trim(args)?.toUpperCase())
  @IsIn(['FL'], { message: 'Installation is available only in Florida.' })
  state: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\d{5}(?:-\d{4})?$/, { message: 'Enter a valid ZIP code.' })
  postalCode: string;
}

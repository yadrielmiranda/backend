import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsBoolean,
  IsEmail,
  IsUrl,
  Matches,
} from 'class-validator';

export class CreateBrandingDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEmail()
  @IsOptional()
  @IsString()
  email?: string;

  @IsUrl()
  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  street?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsUrl()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-F]{6}$/, {
    message: 'brandingColor must use the format #RRGGBB.',
  })
  brandingColor?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

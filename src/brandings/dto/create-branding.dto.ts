import { IsOptional, IsString, IsBoolean, IsEmail, IsUrl } from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

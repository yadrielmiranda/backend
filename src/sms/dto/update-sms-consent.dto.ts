import { IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateSmsConsentDto {
  // unknown impide que enableImplicitConversion convierta "false" en true.
  @IsBoolean()
  enabled!: unknown;

  // Omitirlo conserva la preferencia promocional; compatible con el perfil anterior.
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  promotionsEnabled?: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;
}

import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSmsConsentDto {
  // unknown impide que enableImplicitConversion convierta "false" en true.
  @IsBoolean()
  enabled!: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;
}

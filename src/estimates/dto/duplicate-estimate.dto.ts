import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { trimOnly } from '@/common/transforms';

export class DuplicateEstimateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Transform(trimOnly)
  name?: string;

  // La inclusión de instalación siempre requiere una elección explícita.
  @IsBoolean()
  includeInstallation: boolean;
}

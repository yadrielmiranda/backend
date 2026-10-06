import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMuntinPatternDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsBoolean()
  requiresLites?: boolean;

  @IsOptional()
  @IsIn(['NONE', 'GRID', 'PRESET'])
  inputMode?: 'NONE' | 'GRID' | 'PRESET';

  @IsOptional()
  @IsBoolean()
  requiresType?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

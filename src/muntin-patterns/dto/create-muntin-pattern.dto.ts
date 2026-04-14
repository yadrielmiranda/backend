import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMuntinPatternDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsBoolean()
  requiresLites?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { IsDesignPreviewReference } from '../design-preview-reference';
import { GarageDesignTemplate, IsGarageDesignTemplate } from '../design-template';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const preview = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || null : value;

export class CreateDesignPatternDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Transform(preview)
  @IsOptional()
  @IsDesignPreviewReference()
  imageUrl?: string | null;

  @IsOptional()
  @IsGarageDesignTemplate()
  template?: GarageDesignTemplate | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDesignPatternDto extends PartialType(CreateDesignPatternDto) {}

export class CreateDesignColorDto {
  @IsInt()
  @Min(1)
  idFrameColor: number;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @Matches(/^#[0-9A-F]{6}$/)
  hexCode: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateDesignColorDto extends PartialType(CreateDesignColorDto) {}

import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const FRAME_PRICE_DECIMAL_PATTERN = /^\d{1,18}(?:\.\d{1,20})?$/;
const POSITIVE_FRAME_PRICE_DECIMAL_PATTERN = /^(?!0+(?:\.0+)?$)\d{1,18}(?:\.\d{1,20})?$/;
const decimalText = ({ value }: { value: unknown }) =>
  typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : value;

export class UpdateSystemFrameColorItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  frameColorId: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  modifierEnabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(decimalText)
  @IsString()
  @Matches(POSITIVE_FRAME_PRICE_DECIMAL_PATTERN, {
    message: 'Base price multiplier must be greater than zero, with at most 18 integer digits and 20 decimal digits.',
  })
  basePriceMultiplier?: string | number;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(decimalText)
  @IsString()
  @Matches(FRAME_PRICE_DECIMAL_PATTERN, {
    message: 'Base price deduction must be zero or greater, with at most 18 integer digits and 20 decimal digits.',
  })
  basePriceDeduction?: string | number;
}

export class UpdateSystemFrameColorsDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  frameColorIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayUnique((item: UpdateSystemFrameColorItemDto) => item.frameColorId)
  @ValidateNested({ each: true })
  @Type(() => UpdateSystemFrameColorItemDto)
  frameColors?: UpdateSystemFrameColorItemDto[];
}

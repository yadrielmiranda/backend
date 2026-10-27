import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const DESIGN_PRICE_DECIMAL_PATTERN = /^\d{1,18}(?:\.\d{1,20})?$/;
const POSITIVE_DESIGN_PRICE_DECIMAL_PATTERN =
  /^(?!0+(?:\.0+)?$)\d{1,18}(?:\.\d{1,20})?$/;
const decimalText = ({ value }: { value: unknown }) =>
  typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : value;

export class SystemDesignColorModifierDto {
  @IsInt()
  @Min(1)
  designColorId: number;

  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  modifierEnabled: boolean;

  @Transform(decimalText)
  @IsString()
  @Matches(POSITIVE_DESIGN_PRICE_DECIMAL_PATTERN, {
    message:
      'Base price multiplier must be greater than zero, with at most 18 integer digits and 20 decimal digits.',
  })
  basePriceMultiplier: string | number;

  @Transform(decimalText)
  @IsString()
  @Matches(DESIGN_PRICE_DECIMAL_PATTERN, {
    message:
      'Base price deduction must be zero or greater, with at most 18 integer digits and 20 decimal digits.',
  })
  basePriceDeduction: string | number;
}

export class SystemDesignItemDto {
  @IsInt()
  @Min(1)
  designId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  colorIds: number[];

  @IsInt()
  @Min(0)
  sortOrder: number;
}

export class UpdateSystemDesignsDto {
  @IsBoolean()
  allowDesign: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(240)
  garageMaxSectionHeightIn?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDesignId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDesignColorId?: number | null;

  @IsArray()
  @ArrayUnique((item: SystemDesignItemDto) => item?.designId)
  @ValidateNested({ each: true })
  @Type(() => SystemDesignItemDto)
  designs: SystemDesignItemDto[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayUnique((item: SystemDesignColorModifierDto) => item?.designColorId)
  @ValidateNested({ each: true })
  @Type(() => SystemDesignColorModifierDto)
  colorModifiers?: SystemDesignColorModifierDto[];
}

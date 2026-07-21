import { Type } from "class-transformer";
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { UpsertPricingRangeRuleDto } from "./upsert-pricing-range-rule.dto";

const DIMENSION_DECIMAL_REGEX = /^\d{1,7}(?:\.\d{1,3})?$/;

export class CreatePricingRangeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  idSystem: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  idConfig: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message:
      "code may contain only letters, numbers, hyphens, and underscores.",
  })
  code: string;

  @IsOptional()
  @IsString()
  @Matches(DIMENSION_DECIMAL_REGEX, {
    message:
      "minWidthIn must contain at most 7 integer digits and 3 decimal digits.",
  })
  minWidthIn?: string | null;

  @IsOptional()
  @IsBoolean()
  minWidthInclusive?: boolean;

  @IsOptional()
  @IsString()
  @Matches(DIMENSION_DECIMAL_REGEX, {
    message:
      "maxWidthIn must contain at most 7 integer digits and 3 decimal digits.",
  })
  maxWidthIn?: string | null;

  @IsOptional()
  @IsBoolean()
  maxWidthInclusive?: boolean;

  @IsOptional()
  @IsString()
  @Matches(DIMENSION_DECIMAL_REGEX, {
    message:
      "minHeightIn must contain at most 7 integer digits and 3 decimal digits.",
  })
  minHeightIn?: string | null;

  @IsOptional()
  @IsBoolean()
  minHeightInclusive?: boolean;

  @IsOptional()
  @IsString()
  @Matches(DIMENSION_DECIMAL_REGEX, {
    message:
      "maxHeightIn must contain at most 7 integer digits and 3 decimal digits.",
  })
  maxHeightIn?: string | null;

  @IsOptional()
  @IsBoolean()
  maxHeightInclusive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsArray()
  @ArrayMinSize(1, {
    message: "A pricing range must contain at least one crystal rule.",
  })
  @ArrayUnique((rule: UpsertPricingRangeRuleDto) => rule.idCrystal, {
    message: "Crystal rules cannot be duplicated within a pricing range.",
  })
  @ValidateNested({ each: true })
  @Type(() => UpsertPricingRangeRuleDto)
  rules: UpsertPricingRangeRuleDto[];
}

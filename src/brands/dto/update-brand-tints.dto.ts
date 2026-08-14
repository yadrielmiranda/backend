import { Type } from "class-transformer";
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";

const SURCHARGE_DECIMAL_REGEX = /^\d{1,4}(?:\.\d{1,20})?$/;

export class UpdateBrandTintItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tintId: number;

  @IsBoolean()
  surchargeEnabled: boolean;

  @IsBoolean()
  isDefault: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @Matches(SURCHARGE_DECIMAL_REGEX, {
    message:
      "costoA must contain at most 4 integer digits and 20 decimal digits.",
  })
  costoA?: string | null;

  @IsOptional()
  @IsString()
  @Matches(SURCHARGE_DECIMAL_REGEX, {
    message:
      "costoB must contain at most 4 integer digits and 20 decimal digits.",
  })
  costoB?: string | null;

  @IsOptional()
  @IsString()
  @Matches(SURCHARGE_DECIMAL_REGEX, {
    message:
      "costoC must contain at most 4 integer digits and 20 decimal digits.",
  })
  costoC?: string | null;
}

export class UpdateBrandTintsDto {
  @IsArray()
  @ArrayUnique((item: UpdateBrandTintItemDto) => item.tintId)
  @ValidateNested({ each: true })
  @Type(() => UpdateBrandTintItemDto)
  tints: UpdateBrandTintItemDto[];
}

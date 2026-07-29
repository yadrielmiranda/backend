import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

export class CreateFrameColorDto {
  @IsString()
  @IsNotEmpty()
  color: string;

  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "hexCode must use the format #RRGGBB.",
  })
  hexCode: string;

  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;
}
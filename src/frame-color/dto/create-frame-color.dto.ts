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

  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "hexCode must use the format #RRGGBB.",
  })
  hexCode: string;

  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;
}
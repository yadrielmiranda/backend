import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsNumber, IsOptional, Min } from "class-validator";
import { Type } from "class-transformer";
import { CreateBrandDto } from "./create-brand.dto";

export class UpdateBrandDto extends PartialType(CreateBrandDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  highBottomPercent?: number | null;
}
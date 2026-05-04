import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateBrandDto } from "./create-brand.dto";

export class UpdateBrandDto extends PartialType(CreateBrandDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
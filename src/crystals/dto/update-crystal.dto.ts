import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateCrystalDto } from "./create-crystal.dto";

export class UpdateCrystalDto extends PartialType(CreateCrystalDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
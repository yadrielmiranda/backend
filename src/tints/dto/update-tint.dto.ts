import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateTintDto } from "./create-tint.dto";

export class UpdateTintDto extends PartialType(CreateTintDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
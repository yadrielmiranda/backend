import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateCoatingDto } from "./create-coating.dto";

export class UpdateCoatingDto extends PartialType(CreateCoatingDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
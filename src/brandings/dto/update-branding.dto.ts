import { PartialType } from "@nestjs/mapped-types";
import { CreateBrandingDto } from "./create-branding.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateBrandingDto extends PartialType(CreateBrandingDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

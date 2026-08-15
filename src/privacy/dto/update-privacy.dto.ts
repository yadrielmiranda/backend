import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";

import { CreatePrivacyDto } from "./create-privacy.dto";

export class UpdatePrivacyDto extends PartialType(CreatePrivacyDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

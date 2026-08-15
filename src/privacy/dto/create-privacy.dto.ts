import { Transform } from "class-transformer";
import { IsNotEmpty, IsString } from "class-validator";

export class CreatePrivacyDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;
}

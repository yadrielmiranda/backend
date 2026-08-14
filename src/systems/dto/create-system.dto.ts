import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class CreateSystemDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  idProduct: number;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  idBrand: number;

  @IsOptional()
  @IsBoolean()
  allowHighBottom?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

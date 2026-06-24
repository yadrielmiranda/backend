import { Type } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

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
}
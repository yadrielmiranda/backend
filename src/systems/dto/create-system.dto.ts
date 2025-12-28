import { IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { Type } from 'class-transformer';

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
}

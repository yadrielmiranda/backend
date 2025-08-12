import { IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePricingRuleDto {
  @IsNumber()
  @IsNotEmpty()
  idBrand: number;

  @IsNumber()
  @IsNotEmpty()
  idProduct: number;

  @IsNumber()
  @IsNotEmpty()
  idSystem: number;

  @IsNumber()
  @IsNotEmpty()
  idConfig: number;

  @IsNumber()
  @IsNotEmpty()
  idCrystal: number;

  @IsNumber()
  @Type(() => Number) // Asegura la transformación de string a número
  @IsNotEmpty()
  costoA: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty()
  costoB: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty()
  costoC: number;
}
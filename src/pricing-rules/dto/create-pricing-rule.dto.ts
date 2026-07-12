import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
} from 'class-validator';

const PRICING_DECIMAL_REGEX = /^-?\d{1,4}(?:\.\d{1,20})?$/;

export class CreatePricingRuleDto {
  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  idBrand: number;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  idProduct: number;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  idSystem: number;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  idConfig: number;

  @Type(() => Number)
  @IsInt()
  @IsNotEmpty()
  idCrystal: number;

  @IsString()
  @IsNotEmpty()
  @Matches(PRICING_DECIMAL_REGEX, {
    message:
      'costoA must contain at most 4 integer digits and 20 decimal digits.',
  })
  costoA: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PRICING_DECIMAL_REGEX, {
    message:
      'costoB must contain at most 4 integer digits and 20 decimal digits.',
  })
  costoB: string;

  @IsString()
  @IsNotEmpty()
  @Matches(PRICING_DECIMAL_REGEX, {
    message:
      'costoC must contain at most 4 integer digits and 20 decimal digits.',
  })
  costoC: string;
}
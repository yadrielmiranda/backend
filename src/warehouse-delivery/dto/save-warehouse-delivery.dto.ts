import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// No se convierten vacíos, null o booleanos en importes válidos.
const numericValue = ({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}) => {
  const value = obj[key];
  return typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
};
const trimmedText = ({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}) => (typeof obj[key] === 'string' ? (obj[key] as string).trim() : undefined);

export class SaveWarehouseDeliveryDto {
  @Transform(numericValue)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  revision: number;

  @Transform(trimmedText)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  street: string;

  @Transform(trimmedText)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city: string;

  @Transform((params) => trimmedText(params)?.toUpperCase())
  @IsIn(
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
      ' ',
    ),
  )
  state: string;

  @Transform(trimmedText)
  @IsString()
  @Matches(/^\d{5}(?:-\d{4})?$/, { message: 'Enter a valid ZIP code.' })
  postalCode: string;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  maxDeliveryMiles: number;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(999999.9999)
  basePrice: number;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999.9999)
  includedMiles: number;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999.9999)
  additionalMilePrice: number;
}

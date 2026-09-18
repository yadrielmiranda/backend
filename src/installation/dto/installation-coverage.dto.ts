import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Se valida el valor original para no convertir null, booleanos o vacíos en cero.
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

export class InstallationCoverageRangeDto {
  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  upToMiles: number;

  @IsIn(['FIXED', 'PERCENTAGE'])
  chargeType: 'FIXED' | 'PERCENTAGE';

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  value: number;
}

export class SaveInstallationCoverageDto {
  @Transform(numericValue)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  revision: number;

  @Transform(trimmedText)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  originStreet: string;

  @Transform(trimmedText)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  originCity: string;

  @Transform((params) => trimmedText(params)?.toUpperCase())
  @IsIn(
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
      ' ',
    ),
  )
  originState: string;

  @Transform(trimmedText)
  @IsString()
  @Matches(/^\d{5}(?:-\d{4})?$/, { message: 'Enter a valid ZIP code.' })
  originPostalCode: string;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  maxDistanceMiles: number;

  @Transform(numericValue)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  includedMiles: number;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => InstallationCoverageRangeDto)
  ranges: InstallationCoverageRangeDto[];
}

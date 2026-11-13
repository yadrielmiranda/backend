import { Transform } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

// Preserve JSON types even when the application's implicit conversion is enabled.
const original = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

export class ConfirmedAddressLocationDto {
  @Transform(original)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat: number;

  @Transform(original)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng: number;
}

import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn, IsInt, Min, ValidateIf } from 'class-validator';
import { MUNTIN_AVAILABILITIES, MuntinAvailability } from '../muntin-availability';

export class MuntinAvailabilityDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MUNTIN_AVAILABILITIES)
  muntinAvailability?: MuntinAvailability;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  allowedMuntinTypeIds?: number[];
}

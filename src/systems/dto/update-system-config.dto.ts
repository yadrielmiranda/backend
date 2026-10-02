import {
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import { MuntinAvailabilityDto } from './muntin-availability.dto';

export class UpdateSystemConfigDto extends MuntinAvailabilityDto {
  @IsOptional()
  @IsBoolean()
  allowScreen?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

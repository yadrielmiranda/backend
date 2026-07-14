import {
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

export class UpdateSystemConfigDto {
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
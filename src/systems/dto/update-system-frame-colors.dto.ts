import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsInt, IsOptional } from 'class-validator';

export class UpdateSystemFrameColorsDto {
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  frameColorIds: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultFrameColorId?: number | null;
}
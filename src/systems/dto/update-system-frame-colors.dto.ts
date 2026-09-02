import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';

export class UpdateSystemFrameColorItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  frameColorId: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateSystemFrameColorsDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  frameColorIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayUnique((item: UpdateSystemFrameColorItemDto) => item.frameColorId)
  @ValidateNested({ each: true })
  @Type(() => UpdateSystemFrameColorItemDto)
  frameColors?: UpdateSystemFrameColorItemDto[];
}

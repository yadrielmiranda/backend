import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsInt, IsOptional } from 'class-validator';

export class UpdateSystemCrystalsDto {
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  crystalIds: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultCrystalId?: number | null;
}
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsInt, IsOptional } from 'class-validator';

export class UpdateSystemConfigOptionsDto {
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  activeOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  preparationOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  sillOptionIds: number[];

  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  reinforcementOptionIds: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultActiveOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultPreparationOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultSillOptionId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultReinforcementOptionId?: number | null;
}
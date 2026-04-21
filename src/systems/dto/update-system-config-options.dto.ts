import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsInt } from 'class-validator';

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
}
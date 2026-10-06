import { Type } from 'class-transformer';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsInt, Min, ValidateIf, ValidateNested } from 'class-validator';

export class MuntinTargetDto {
  @IsInt()
  @Min(1)
  configId: number;

  @IsInt()
  @Min(1)
  crystalId: number;
}

export class UpdateSystemMuntinRuleDto {
  @IsIn(['ALL', 'SELECTED'])
  availability: 'ALL' | 'SELECTED';

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  allowedTypeIds?: number[];
}

export class ApplySystemMuntinsDto {
  @IsInt()
  @Min(1)
  patternId: number;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MuntinTargetDto)
  targets: MuntinTargetDto[];

  @IsIn(['NONE', 'ALL', 'SELECTED'])
  availability: 'NONE' | 'ALL' | 'SELECTED';

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  allowedTypeIds?: number[];
}

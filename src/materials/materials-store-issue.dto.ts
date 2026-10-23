import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { MaterialRequestDto } from './materials.dto';

export class MaterialStoreIssueLineDto {
  // Preserve JSON types even when the application's implicit conversion is enabled.
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(1) @Max(2147483647) productId: number;
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(1) @Max(2147483647) presentationId: number;
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(1) @Max(1000000) quantity: number;
}

export class TechnicianMaterialStoreIssueDto extends MaterialRequestDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000)
  @ValidateNested({ each: true }) @Type(() => MaterialStoreIssueLineDto)
  lines: MaterialStoreIssueLineDto[];
}

export class MaterialStoreIssueDto extends TechnicianMaterialStoreIssueDto {
  @Transform(({ obj, key }) => obj[key])
  @IsString() @Length(1, 200) recipient: string;
  @Transform(({ obj, key }) => obj[key])
  @IsString() @Length(1, 1000) note: string;
}

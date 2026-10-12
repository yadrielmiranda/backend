import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { MaterialRequestDto } from './materials.dto';

export class MaterialStoreCountPresentationDto {
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(1) @Max(2147483647) presentationId: number;
  // A blank count is not a zero count, even with global implicit conversion enabled.
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(0) @Max(1000000) quantity: number;
}

export class MaterialStoreCountProductDto {
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(1) @Max(2147483647) productId: number;
  @Transform(({ obj, key }) => obj[key])
  @IsInt() @Min(0) @Max(2147483647) version: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000)
  @ValidateNested({ each: true }) @Type(() => MaterialStoreCountPresentationDto)
  counts: MaterialStoreCountPresentationDto[];
}

export class MaterialStoreCountDto extends MaterialRequestDto {
  @IsString() @Length(1, 1000) note: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000)
  @ValidateNested({ each: true }) @Type(() => MaterialStoreCountProductDto)
  products: MaterialStoreCountProductDto[];
}

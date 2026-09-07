import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
export class PromotionDto {
  @IsString() @MaxLength(120) name!: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(100) percent!: number;
  @IsIn(['ALL', 'ROLE', 'USERS']) audience!: string;
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  roleIds?: number[];
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  userIds?: number[];
  @IsOptional() @IsInt() @Min(1) brandId?: number;
  @IsOptional() @IsInt() @Min(1) productId?: number;
  @IsOptional() @IsInt() @Min(1) systemId?: number;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsBoolean() enabled!: boolean;
}

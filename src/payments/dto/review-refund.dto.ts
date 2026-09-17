import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class RefundAllocationReviewDto {
  @IsInt() @Min(1) id: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) creditAmount: number;
}

export class ReviewRefundDto {
  @IsString() @MinLength(3) @MaxLength(1000) note: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RefundAllocationReviewDto)
  allocations: RefundAllocationReviewDto[];
}

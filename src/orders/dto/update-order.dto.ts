import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsNumber } from 'class-validator';

export class UpdateOrderDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  statusId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(({ value }) => (value === '' ? null : value))
  poNumber?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsNumber()
  rateReal?: number | null;
}

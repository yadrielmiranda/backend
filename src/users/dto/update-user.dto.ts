import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  markupOverride?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
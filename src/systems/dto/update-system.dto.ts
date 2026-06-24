import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSystemDto } from './create-system.dto';

export class UpdateSystemDto extends PartialType(CreateSystemDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  allowHighBottom?: boolean;
}
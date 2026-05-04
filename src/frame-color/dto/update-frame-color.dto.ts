import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateFrameColorDto } from './create-frame-color.dto';

export class UpdateFrameColorDto extends PartialType(CreateFrameColorDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
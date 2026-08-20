import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === undefined ? value : String(value).trim(),
  )
  @IsString()
  @Matches(/^-?\d{1,6}(?:\.\d{1,18})?$/, {
    message:
      'markupOverride must fit within 6 integer and 18 decimal places.',
  })
  markupOverride?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';
import { trimOnly } from '@/common/transforms';
import {
  USERNAME_PATTERN,
  USERNAME_VALIDATION_MESSAGE,
} from '@/common/username-policy';

// DTO independiente: no debilita el registro público ni acepta campos comerciales.
export class CreateTechnicianDto {
  @IsString() @Transform(trimOnly)
  @Matches(USERNAME_PATTERN, { message: USERNAME_VALIDATION_MESSAGE })
  username: string;

  @IsString() @IsNotEmpty() @MaxLength(100) @Transform(trimOnly)
  firstName: string;

  @IsString() @IsNotEmpty() @MaxLength(100) @Transform(trimOnly)
  lastName: string;

  @IsString() @Length(8, 72)
  password: string;
}

export class UpdateTechnicianDto extends PartialType(CreateTechnicianDto) {}

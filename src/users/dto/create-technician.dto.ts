import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';
import { trimOnly } from '@/common/transforms';

// DTO independiente: no debilita el registro público ni acepta campos comerciales.
export class CreateTechnicianDto {
  @IsString() @Length(3, 50) @Transform(trimOnly)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'Use letters, numbers, dots, underscores or hyphens for the username.',
  })
  username: string;

  @IsString() @IsNotEmpty() @MaxLength(100) @Transform(trimOnly)
  firstName: string;

  @IsString() @IsNotEmpty() @MaxLength(100) @Transform(trimOnly)
  lastName: string;

  @IsString() @Length(8, 72)
  password: string;
}

export class UpdateTechnicianDto extends PartialType(CreateTechnicianDto) {}

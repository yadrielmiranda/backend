import { PickType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import { normalizeZip5OrNull } from '@/common/transforms';
import { UpdateUserDto } from '@/users/dto/update-user.dto';
import { PROFILE_FIELDS } from './self-service-fields';

// La contraseña tiene su propio flujo con verificación de la contraseña actual.
export class UpdateProfileDto extends PickType(UpdateUserDto, PROFILE_FIELDS.filter(key => key !== 'postalCode')) {
  @IsOptional()
  @Transform(({ value }) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return typeof trimmed === 'string' && /^\d{5}-\d{4}$/.test(trimmed)
      ? trimmed : normalizeZip5OrNull({ value });
  })
  @IsString()
  @Matches(/^\d{5}(?:-\d{4})?$/, { message: 'Enter a ZIP code or ZIP+4.' })
  postalCode?: string;
}

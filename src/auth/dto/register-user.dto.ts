import { PickType } from '@nestjs/mapped-types';
import { CreateUserDto } from '@/users/dto/create-user.dto';
import { IsBoolean, IsInt, IsString, Matches, Min, ValidateIf } from 'class-validator';
import { PROFILE_FIELDS } from './self-service-fields';

// Las condiciones comerciales se asignan exclusivamente desde administración.
export class RegisterUserDto extends PickType(CreateUserDto, [...PROFILE_FIELDS, 'password'] as const) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  platformTermsAccepted?: unknown;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  platformTermsVersionId?: number;

  // unknown evita que la conversión implícita acepte cadenas como "false".
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  serviceConsent?: unknown;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  promotionsConsent?: unknown;

  // Sin SMS no se exige aceptar ni cargar una versión de las condiciones SMS.
  @ValidateIf((object) => object.serviceConsent === true || object.promotionsConsent === true)
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'Review the current SMS terms before subscribing.' })
  consentVersion?: string;
}

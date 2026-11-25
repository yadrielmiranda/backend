import { IntersectionType, PartialType, PickType } from '@nestjs/mapped-types';
import { CreateUserDto } from '@/users/dto/create-user.dto';
import { IsBoolean, IsInt, IsString, Matches, Min, MinLength, ValidateIf } from 'class-validator';

// Las condiciones comerciales se asignan exclusivamente desde administración.
export class RegistrationConsentsDto {
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

export class RegisterUserDto extends IntersectionType(
  PickType(CreateUserDto, ['firstName', 'lastName', 'email', 'phone', 'password'] as const),
  PartialType(PickType(CreateUserDto, ['username', 'street', 'addressLine2', 'city', 'state', 'postalCode'] as const), { skipNullProperties: false }),
  RegistrationConsentsDto,
) {
  @MinLength(8)
  declare password: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,40}$/)
  referralCode?: string;
}

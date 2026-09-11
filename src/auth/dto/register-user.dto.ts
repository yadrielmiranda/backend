import { OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from '@/users/dto/create-user.dto';
import { IsBoolean, IsString, Matches, ValidateIf } from 'class-validator';

// Este DTO hereda todas las validaciones de CreateUserDto
// pero omite el campo 'idRole' para que no se pueda inyectar en el registro público.
export class RegisterUserDto extends OmitType(CreateUserDto, [
  'idRole',
  'installationPriceProfileId',
] as const) {
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

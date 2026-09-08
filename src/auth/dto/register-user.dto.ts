import { OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from '@/users/dto/create-user.dto';
import { Equals, IsBoolean, IsString, Matches, ValidateIf } from 'class-validator';

// Este DTO hereda todas las validaciones de CreateUserDto
// pero omite el campo 'idRole' para que no se pueda inyectar en el registro público.
export class RegisterUserDto extends OmitType(CreateUserDto, [
  'idRole',
  'installationPriceProfileId',
] as const) {
  // unknown evita que la conversión implícita acepte cadenas como "false".
  @IsBoolean()
  @Equals(true, { message: 'You must agree to service notifications by SMS and email to create an account.' })
  serviceConsent!: unknown;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  promotionsConsent?: unknown;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'Review the current messaging terms before creating an account.' })
  consentVersion!: string;
}

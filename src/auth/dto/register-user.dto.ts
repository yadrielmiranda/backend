import { OmitType } from '@nestjs/mapped-types';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

// Este DTO hereda todas las validaciones de CreateUserDto
// pero omite el campo 'idRole' para que no se pueda inyectar en el registro público.
export class RegisterUserDto extends OmitType(CreateUserDto, ['idRole'] as const) {}
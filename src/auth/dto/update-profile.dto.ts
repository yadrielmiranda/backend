import { PickType } from '@nestjs/mapped-types';
import { UpdateUserDto } from '@/users/dto/update-user.dto';
import { PROFILE_FIELDS } from './self-service-fields';

// La contraseña tiene su propio flujo con verificación de la contraseña actual.
export class UpdateProfileDto extends PickType(UpdateUserDto, PROFILE_FIELDS) {}

import { OmitType } from '@nestjs/mapped-types';
import { UpdateUserDto } from '@/users/dto/update-user.dto';

// El usuario no puede cambiar permisos de dealer desde su perfil personal.
export class UpdateProfileDto extends OmitType(UpdateUserDto, [
  'paymentPlanId', 'idRole', 'dealerMode', 'noInstallationDeposit',
] as const) {}

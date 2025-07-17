import { OmitType } from '@nestjs/mapped-types';
import { UpdateUserDto } from 'src/users/dto/update-user.dto';

// Este DTO hereda todo de UpdateUserDto, pero omite 'idRole'.
export class UpdateProfileDto extends OmitType(UpdateUserDto, ['idRole'] as const) {}
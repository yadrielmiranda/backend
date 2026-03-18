import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateSystemConfigDto {
  @IsBoolean()
  @IsNotEmpty()
  allowScreen: boolean;
}
import { IsInt, IsNotEmpty, IsString } from 'class-validator';

export class CreateNotificationDto {
  @IsInt()
  @IsNotEmpty()
  recipientId: number;

  @IsString()
  @IsNotEmpty()
  message: string;
}

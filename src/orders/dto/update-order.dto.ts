import { IsInt, IsNotEmpty } from 'class-validator';

export class UpdateOrderDto {
  @IsInt()
  @IsNotEmpty()
  statusId: number;
}
import { IsDecimal, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateRoleDto {
  @IsNumber()
  @Type(() => Number) // Transforma el valor a número
  @IsNotEmpty()
  markup: number;
}
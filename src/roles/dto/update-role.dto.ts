import { IsInt, IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateRoleDto {
  @IsNumber()
  @Type(() => Number) // Transforma el valor a número
  @IsNotEmpty()
  markup: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  installationPriceProfileId?: number | null;
}

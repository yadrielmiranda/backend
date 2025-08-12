import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';
import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateUserDto extends PartialType(CreateUserDto) {
    @IsOptional()
    @IsNumber()
    @Min(0) // El markup no puede ser negativo
    @Type(() => Number)
    markupOverride?: number | null;
}

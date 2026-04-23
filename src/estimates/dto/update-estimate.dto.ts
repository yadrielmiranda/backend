import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateEstimateDto } from './create-estimate.dto';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
import { IsArray, ValidateNested, IsOptional, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class UpsertPieceDto extends CreatePieceDto {
    @IsOptional()
    @IsInt()
    id?: number;

    @IsOptional()
    @IsInt()
    idEst?: number;
}

export class UpdateEstimateDto extends PartialType(OmitType(CreateEstimateDto, ['pieces'] as const)) {
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => UpsertPieceDto)
    pieces?: UpsertPieceDto[];
}

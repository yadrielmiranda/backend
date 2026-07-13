import { IsInt, IsOptional } from 'class-validator';

import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';

export class UpsertPieceDto extends CreatePieceDto {
    @IsOptional()
    @IsInt()
    id?: number;
}
// src/estimates/dto/create-estimate.dto.ts

import { IsNotEmpty, IsString, IsNumber, IsArray, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CreatePieceDto } from "src/pieces/dto/create-piece.dto"; // Asegúrate que la ruta sea correcta

export class CreateEstimateDto {
    @IsNotEmpty() @IsString() number: string;
    @IsNotEmpty() @IsString() name: string;
    @IsNotEmpty() @IsString() project: string;
    @IsNotEmpty() @IsNumber() idUser: number;
    
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreatePieceDto)
    pieces: CreatePieceDto[];
}
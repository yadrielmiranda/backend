// src/estimates/dto/create-estimate.dto.ts
import { IsNotEmpty, IsString, IsArray, ValidateNested, IsOptional } from "class-validator";
import { Type } from "class-transformer";
import { CreatePieceDto } from "src/pieces/dto/create-piece.dto";
import { ApiProperty } from "@nestjs/swagger";

export class CreateEstimateDto {
    @ApiProperty()
    @IsNotEmpty() 
    @IsString() 
    name: string;
    
    @ApiProperty({ required: false })
    @IsOptional() 
    @IsString() 
    project?: string;

    @ApiProperty({ type: () => [CreatePieceDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreatePieceDto)
    pieces: CreatePieceDto[];
}

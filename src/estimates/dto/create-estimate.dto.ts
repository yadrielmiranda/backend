import { IsNotEmpty, IsString, IsArray, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CreatePieceDto } from "src/pieces/dto/create-piece.dto";

export class CreateEstimateDto {

    @IsNotEmpty() @IsString() name: string;     
     
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreatePieceDto)
    pieces: CreatePieceDto[];
}

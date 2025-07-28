// src/pieces/dto/create-piece.dto.ts

import { IsBoolean, IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreatePieceDto {

    @IsString()
    @IsNotEmpty()
    mark: string;

    @IsNumber()
    @IsNotEmpty()
    idProd: number; 

    @IsNumber()
    @IsNotEmpty()
    idBrand: number;  

    @IsNumber()
    @IsNotEmpty()
    idSyst: number;

    @IsNumber()
    @IsNotEmpty()
    idConf: number;

    @IsNumber()
    @IsNotEmpty()
    idFC: number;

    @IsString()
    @IsNotEmpty()
    width: string;

    @IsString()
    @IsNotEmpty()
    height:string;

    @IsNumber()
    @IsNotEmpty()
    idCryst: number;

    @IsNumber()
    @IsNotEmpty()
    idTint: number;

    @IsBoolean()
    privacy: boolean; 

    @IsNumber()
    @IsNotEmpty()
    idCoat: number;

    @IsBoolean()
    screen: boolean;

    @IsBoolean()
    muntin: boolean;     

    @IsNumber()
    @IsNotEmpty()
    qty: number;         
 
}
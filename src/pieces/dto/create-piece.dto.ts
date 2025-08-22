import { IsBoolean, IsNotEmpty, IsNumber, IsString, IsOptional, IsInt } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePieceDto {
    @ApiProperty() @IsString() @IsNotEmpty() mark: string;
    @ApiProperty() @IsInt() @IsNotEmpty() idProd: number; 
    @ApiProperty() @IsInt() @IsNotEmpty() idBrand: number;  
    @ApiProperty() @IsInt() @IsNotEmpty() idSyst: number;
    @ApiProperty() @IsInt() @IsNotEmpty() idConf: number;
    @ApiProperty() @IsInt() @IsNotEmpty() idFC: number;
    @ApiProperty() @IsString() @IsNotEmpty() width: string;
    @ApiProperty() @IsString() @IsNotEmpty() height:string;
    @ApiProperty() @IsInt() @IsNotEmpty() idCryst: number;
    @ApiProperty() @IsInt() @IsNotEmpty() idTint: number;
    @ApiProperty() @IsBoolean() privacy: boolean; 
    @ApiProperty() @IsInt() @IsNotEmpty() idCoat: number;
    @ApiProperty() @IsBoolean() screen: boolean;
    @ApiProperty() @IsBoolean() muntin: boolean;     
    @ApiProperty() @IsInt() @IsNotEmpty() qty: number;

    // ÚNICO campo adicional que viene del frontend, solo para dealers.
    @ApiPropertyOptional() 
    @IsOptional() 
    @IsNumber() 
    dealerMarkup?: number;
}

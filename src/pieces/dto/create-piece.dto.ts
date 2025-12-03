import { IsBoolean, IsNotEmpty, IsNumber, IsString, IsOptional, IsInt, IsNumberString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePieceDto {
    @ApiProperty() @IsString() @IsNotEmpty() mark: string;
    @ApiProperty() @IsInt() @IsNotEmpty() idProd: number; 
    @ApiProperty() @IsInt() @IsNotEmpty() idBrand: number;  
    @ApiProperty() @IsInt() @IsNotEmpty() idSyst: number;
    @ApiProperty() @IsInt() @IsNotEmpty() idConf: number;
    @ApiProperty() @IsInt() @IsNotEmpty() idFC: number;
    @ApiPropertyOptional() @IsOptional() @IsNumberString() width?: string;
    @ApiPropertyOptional() @IsOptional() @IsNumberString() height?: string;
    @ApiPropertyOptional() @IsOptional() @IsNumberString() heightLeft?: string;
    @ApiPropertyOptional() @IsOptional() @IsNumberString() heightRight?: string;
    @ApiPropertyOptional() @IsOptional() @IsNumberString() legHeight?: string;
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

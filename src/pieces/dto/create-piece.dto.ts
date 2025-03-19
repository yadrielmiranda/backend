import { IsBoolean, IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreatePieceDto {

    @IsNumber()
    @IsNotEmpty()
    idEst: number;

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
    @IsNotEmpty()
    privacy: boolean;

    @IsNumber()
    @IsNotEmpty()
    idCoat: number;

    @IsBoolean()
    @IsNotEmpty()
    screen: boolean;

    @IsBoolean()
    @IsNotEmpty()
    muntin: boolean;    

    @IsNumber()
    @IsNotEmpty()
    qty: number; 
    
    @IsNumber()
    @IsNotEmpty()
    price: number;

    @IsNumber()
    @IsNotEmpty()
    rate: number;

    @IsNumber()
    @IsNotEmpty()
    markup: number; 

    @IsNumber()
    @IsNotEmpty()
    subtotal: number;

    @IsNumber()
    @IsNotEmpty()
    netProfit: number; 
    
}

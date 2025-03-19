import { IsBoolean, IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateEstimateDto {

    @IsNotEmpty()
    @IsString()
    number: string;

    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNotEmpty()
    @IsString()
    project: string;

    @IsNumber()
    @IsNotEmpty()
    units: number

    @IsNumber()
    @IsNotEmpty()
    rateT: number;

    @IsNumber()
    @IsNotEmpty()
    priceT: number;

    @IsNumber()
    @IsNotEmpty()
    netProfit: number;

    @IsNumber()
    @IsNotEmpty()
    idUser: number;

    @IsBoolean()
    @IsNotEmpty()
    active: boolean    
}

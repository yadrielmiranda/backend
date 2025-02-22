import { IsBoolean, IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateEstimateDto {

    @IsNotEmpty()
    @IsString()
    code: string;

    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    units: number

    @IsNumber()
    @IsNotEmpty()
    total: number;

    @IsNumber()
    @IsNotEmpty()
    idUser: number;

    @IsBoolean()
    @IsNotEmpty()
    active: boolean  
  
}

import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateSystemDto {

    @IsNotEmpty()
    @IsString()                  
    name: string; 

    @IsNumber()
    @IsNotEmpty()
    prod: number;  // es el id del producto al que pertenece este sistema
}
    
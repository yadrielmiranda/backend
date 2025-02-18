import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateSystemDto {

    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    idProduct: number;  // es el id del producto al que pertenece este sistema
}

import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateConfigDto {

    @IsString()
    @IsNotEmpty()
    conf: string;

    @IsNumber()
    @IsNotEmpty()
    idProduct: number;
}

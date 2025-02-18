import { IsNotEmpty, IsString } from "class-validator";

export class CreateTintDto {

    @IsString()
    @IsNotEmpty()
    color: string;
}

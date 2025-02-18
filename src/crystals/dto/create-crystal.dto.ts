import { IsNotEmpty, IsString } from "class-validator";

export class CreateCrystalDto {

    @IsString()
    @IsNotEmpty()
    glass: string;
}
